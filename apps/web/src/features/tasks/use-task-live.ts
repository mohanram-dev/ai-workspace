"use client";

import {
  browserFrameDeltaSchema,
  computerFrameDeltaSchema,
  STREAM_END_EVENT_TYPES,
  STREAM_END_STATUSES,
  stepOutputDeltaSchema,
  taskEventEnvelopeSchema,
  terminalOutputDeltaSchema,
  type TaskEvent,
  type TaskWithStepsDto,
} from "@aiw/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api-client";
import { controlTask, fetchTask, type TaskAction } from "./api";
import type { BrowserLiveState } from "./browser-view";
import type { ComputerLiveState } from "./computer-view";
import type { TerminalChunks } from "./tool-views";

export type StreamState = "idle" | "connecting" | "live" | "ended" | "reconnecting";

/** Event types that only change status text or logs; everything else refreshes the task snapshot. */
const LOCAL_ONLY_EVENTS = new Set<TaskEvent["type"]>([
  "THINKING_STATUS",
  "MODEL_CALL_FINISHED",
  "FILE_READ",
  "FILE_CREATED",
  "FILE_UPDATED",
  "PAGE_READ",
  "TERMINAL_COMMAND_STARTED",
  "TERMINAL_COMMAND_FINISHED",
  "BROWSER_OPENED",
  "PAGE_NAVIGATED",
  "BROWSER_ACTION",
  "BROWSER_CLOSED",
  "COMPUTER_STARTED",
  "COMPUTER_ACTION",
  "COMPUTER_STOPPED",
]);
const MAX_EVENTS = 2000;

function isIdle(task: TaskWithStepsDto): boolean {
  return STREAM_END_STATUSES.includes(task.status) && !task.pauseRequested;
}

interface UseTaskLiveOptions {
  /**
   * Open the stream even for a finished task, to load its timeline (task page).
   * Chat cards leave this off and only connect while the task is active.
   */
  loadHistory?: boolean;
}

/**
 * Live task state: loads a snapshot, follows the SSE event stream (history,
 * then live events and streamed step output) and refreshes the snapshot when
 * structural events arrive.
 */
export function useTaskLive(taskId: string, initial: TaskWithStepsDto | null = null, options: UseTaskLiveOptions = {}) {
  const [task, setTask] = useState<TaskWithStepsDto | null>(initial);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [output, setOutput] = useState<Record<string, string>>({});
  const [terminal, setTerminal] = useState<TerminalChunks>({});
  const [browser, setBrowser] = useState<BrowserLiveState>({ frame: null, open: false });
  const [computer, setComputer] = useState<ComputerLiveState>({ frame: null, open: false });
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<TaskAction | null>(null);
  const [generation, setGeneration] = useState(0);
  const [follow, setFollow] = useState(Boolean(options.loadHistory) || (initial !== null && !isIdle(initial)));

  const lastEventId = useRef(0);
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const latest = await fetchTask(taskId);
      setTask(latest);
      setError(null);
      return latest;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  }, [taskId]);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refresh(), 120);
  }, [refresh]);

  useEffect(() => () => window.clearTimeout(refreshTimer.current), []);

  useEffect(() => {
    if (initial) return;
    // Initial snapshot for cards rendered without server data; state updates happen after the fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh().then((latest) => {
      if (latest && !isIdle(latest)) setFollow(true);
    });
  }, [initial, refresh]);

  useEffect(() => {
    if (!follow) return;
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let disposed = false;

    const connect = () => {
      // Resume after the last event already applied; the server replays anything newer.
      source = new EventSource(`/api/tasks/${taskId}/events?after=${lastEventId.current}`);
      setStreamState("connecting");

      source.addEventListener("open", () => setStreamState("live"));

      source.addEventListener("task", (message) => {
        const parsed = taskEventEnvelopeSchema.safeParse(JSON.parse((message as MessageEvent<string>).data));
        if (!parsed.success) return;
        const event = parsed.data as TaskEvent;
        if (event.id <= lastEventId.current) return;
        lastEventId.current = event.id;
        setEvents((current) => [...(current.length >= MAX_EVENTS ? current.slice(1) : current), event]);
        if (event.type === "STEP_STARTED" && event.stepId) {
          const stepId = event.stepId;
          setOutput((current) => ({ ...current, [stepId]: "" }));
        }
        if (event.type === "BROWSER_OPENED") setBrowser((current) => ({ ...current, open: true }));
        if (event.type === "BROWSER_CLOSED" || STREAM_END_EVENT_TYPES.includes(event.type)) setBrowser((current) => ({ ...current, open: false }));
        if (event.type === "COMPUTER_STARTED") setComputer((current) => ({ ...current, open: true }));
        if (event.type === "COMPUTER_STOPPED" || STREAM_END_EVENT_TYPES.includes(event.type)) setComputer((current) => ({ ...current, open: false }));
        if (!LOCAL_ONLY_EVENTS.has(event.type)) scheduleRefresh();
      });

      source.addEventListener("browser", (message) => {
        const parsed = browserFrameDeltaSchema.safeParse(JSON.parse((message as MessageEvent<string>).data));
        if (!parsed.success) return;
        setBrowser({ frame: parsed.data, open: true });
      });

      source.addEventListener("computer", (message) => {
        const parsed = computerFrameDeltaSchema.safeParse(JSON.parse((message as MessageEvent<string>).data));
        if (!parsed.success) return;
        setComputer({ frame: parsed.data, open: true });
      });

      source.addEventListener("delta", (message) => {
        const parsed = stepOutputDeltaSchema.safeParse(JSON.parse((message as MessageEvent<string>).data));
        if (!parsed.success) return;
        const { stepId, text, reset } = parsed.data;
        setOutput((current) => ({ ...current, [stepId]: reset ? text : (current[stepId] ?? "") + text }));
      });

      source.addEventListener("terminal", (message) => {
        const parsed = terminalOutputDeltaSchema.safeParse(JSON.parse((message as MessageEvent<string>).data));
        if (!parsed.success) return;
        const { toolCallId, stream, text } = parsed.data;
        setTerminal((current) => ({ ...current, [toolCallId]: [...(current[toolCallId] ?? []), { stream, text }] }));
      });

      source.addEventListener("end", () => {
        source?.close();
        setStreamState("ended");
        scheduleRefresh();
      });

      source.addEventListener("error", () => {
        if (disposed) return;
        setStreamState("reconnecting");
        if (source?.readyState === EventSource.CLOSED) {
          // The browser stopped retrying; reconnect after a pause.
          retryTimer = window.setTimeout(connect, 3000);
        }
      });
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [taskId, follow, generation, scheduleRefresh]);

  const run = useCallback(
    async (action: TaskAction): Promise<TaskWithStepsDto | null> => {
      setPendingAction(action);
      try {
        const result = await controlTask(taskId, action);
        if (action === "retry") return result;
        setTask(result);
        if (!isIdle(result)) {
          // Execution (re)started or is about to pause: follow the stream again.
          setFollow(true);
          setGeneration((g) => g + 1);
        }
        return result;
      } catch (e) {
        toast.error(errorMessage(e));
        return null;
      } finally {
        setPendingAction(null);
      }
    },
    [taskId],
  );

  return { task, events, output, terminal, browser, computer, streamState, statusText: currentStatusText(events), error, pendingAction, run, refresh };
}

/** The latest THINKING_STATUS that has not been superseded by a lifecycle event. */
function currentStatusText(events: TaskEvent[]): { text: string; warning: boolean } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "APPROVAL_REQUIRED") return { text: `Waiting for your approval: ${event.data.action}`, warning: true };
    if (event.type === "THINKING_STATUS") return { text: event.data.text, warning: event.status === "warning" };
    if (event.type === "BROWSER_ACTION" || event.type === "PAGE_NAVIGATED" || event.type === "COMPUTER_ACTION") return { text: event.description, warning: false };
    if (event.type === "TOOL_CALL_STARTED") return { text: `Calling ${event.data.toolName}…`, warning: false };
    if (["STEP_COMPLETED", "TASK_COMPLETED", "TASK_FAILED", "TASK_CANCELLED", "TASK_PAUSED"].includes(event.type)) return null;
  }
  return null;
}
