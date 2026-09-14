import { getTask, listTaskEvents, type Database } from "@aiw/database";
import { STREAM_END_EVENT_TYPES, STREAM_END_STATUSES, type TaskEvent } from "@aiw/shared";
import { toTaskEvent, type TaskBusMessage, type TaskEventBus } from "./events";

export interface TaskEventStreamOptions {
  db: Database;
  bus: TaskEventBus;
  taskId: string;
  /** Replay only events with an id greater than this (SSE Last-Event-ID). */
  afterId: number;
  heartbeatMs?: number;
}

const REPLAY_PAGE_SIZE = 500;

function frame(lines: { id?: number; event?: string; data?: unknown; comment?: string }): string {
  if (lines.comment !== undefined) return `: ${lines.comment}\n\n`;
  let out = "";
  if (lines.id !== undefined) out += `id: ${lines.id}\n`;
  if (lines.event) out += `event: ${lines.event}\n`;
  out += `data: ${JSON.stringify(lines.data ?? {})}\n\n`;
  return out;
}

/**
 * Server-Sent Events stream for one task:
 * - `event: task` (with `id`) for every persisted event, replayed from `afterId` then live
 * - `event: delta` for streamed step output, `event: terminal` for command output and `event: browser` for live preview frames (ephemeral, no id)
 * - `event: end` once the task is completed, failed, cancelled or paused
 *
 * Subscribes before replaying and de-duplicates by id, so no event is lost or
 * repeated between the replay and live phases.
 */
export function createTaskEventStream(options: TaskEventStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const cleanup = () => {
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastId = options.afterId;
      let replaying = true;
      const buffered: TaskBusMessage[] = [];

      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };

      const end = () => {
        if (closed) return;
        write(frame({ event: "end", data: { lastEventId: lastId } }));
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      const sendEvent = (event: TaskEvent, live: boolean) => {
        if (event.id <= lastId) return;
        lastId = event.id;
        write(frame({ id: event.id, event: "task", data: event }));
        if (live && STREAM_END_EVENT_TYPES.includes(event.type)) end();
      };

      const handle = (message: TaskBusMessage) => {
        if (message.kind === "event") sendEvent(message.event, true);
        else if (message.kind === "delta") write(frame({ event: "delta", data: message.delta }));
        else if (message.kind === "terminal") write(frame({ event: "terminal", data: message.output }));
        else if (message.kind === "browser") write(frame({ event: "browser", data: message.frame }));
        else write(frame({ event: "computer", data: message.frame }));
      };

      unsubscribe = options.bus.subscribe(options.taskId, (message) => {
        if (replaying) buffered.push(message);
        else handle(message);
      });

      try {
        for (;;) {
          const rows = await listTaskEvents(options.db, options.taskId, { afterId: lastId, limit: REPLAY_PAGE_SIZE });
          for (const row of rows) sendEvent(toTaskEvent(row), false);
          if (rows.length < REPLAY_PAGE_SIZE) break;
        }
        replaying = false;
        for (const message of buffered.splice(0)) {
          // Deltas that arrived during replay belong to output the client has not seen; keep them.
          handle(message);
          if (closed) return;
        }

        const task = await getTask(options.db, options.taskId);
        if (!task || STREAM_END_STATUSES.includes(task.status)) {
          end();
          return;
        }

        write(frame({ comment: "connected" }));
        heartbeat = setInterval(() => write(frame({ comment: "ping" })), options.heartbeatMs ?? 15_000);
      } catch (error) {
        console.error(`Task event stream for ${options.taskId} failed`, error);
        write(frame({ event: "error", data: { message: "The event stream failed. Reconnecting may help." } }));
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
    cancel() {
      cleanup();
    },
  });
}
