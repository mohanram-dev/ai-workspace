"use client";

import {
  isActiveTaskStatus,
  type MessageDto,
  type TaskWithStepsDto,
} from "@aiw/shared";
import {
  ArrowUpRightIcon,
  BrainCircuitIcon,
  ChevronRightIcon,
  WandSparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCost, formatDuration, formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentIcon } from "../agents/agent-icon";
import { ActivityTimeline } from "./activity-timeline";
import { ApprovalPanel, pendingApproval } from "./approval-panel";
import { BrowserView, currentBrowserAction } from "./browser-view";
import { ComputerView, currentComputerAction } from "./computer-view";
import type { TaskAction } from "./api";
import {
  StepList,
  TaskControls,
  TaskErrorPanel,
  TaskProgressBar,
  TaskResult,
} from "./task-parts";
import { TaskStatusBadge } from "./task-status";
import { TerminalView } from "./tool-views";
import { useTaskLive, type StreamState } from "./use-task-live";

interface TaskReplyProps {
  taskId: string;
  /** Keeps the chat's message state in sync with the task (busy state, retry target). */
  onMessageChange: (patch: Partial<MessageDto>) => void;
}

/** An agent task rendered inside a conversation, updated live over SSE. */
export function TaskReply({ taskId, onMessageChange }: TaskReplyProps) {
  const live = useTaskLive(taskId);
  const { task } = live;
  const reported = useRef<string | null>(null);

  // Mirror the task's state into the message so the composer locks and unlocks.
  useEffect(() => {
    if (!task) return;
    const settled = !isActiveTaskStatus(task.status);
    const key = `${task.id}:${task.status}:${task.attempt}`;
    if (reported.current === key) return;
    reported.current = key;
    onMessageChange(
      settled
        ? {
            status:
              task.status === "completed"
                ? "completed"
                : task.status === "failed"
                  ? "failed"
                  : "cancelled",
            content: task.result ?? "",
            error: task.error?.message ?? null,
            inputTokens: task.inputTokens || null,
            outputTokens: task.outputTokens || null,
            model: task.model,
          }
        : { status: "streaming" },
    );
  }, [task, onMessageChange]);

  async function onAction(action: TaskAction) {
    const result = await live.run(action);
    if (result && action === "retry")
      onMessageChange({
        taskId: result.id,
        status: "streaming",
        content: "",
        error: null,
      });
  }

  if (!task) {
    return live.error ? (
      <p className="text-sm text-destructive">{live.error}</p>
    ) : (
      <div className="grid gap-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <TaskReplyBody task={task} live={live} onAction={(a) => void onAction(a)} />
  );
}

function TaskReplyBody({
  task,
  live,
  onAction,
}: {
  task: TaskWithStepsDto;
  live: ReturnType<typeof useTaskLive>;
  onAction: (action: TaskAction) => void;
}) {
  const active = isActiveTaskStatus(task.status);
  const executing = active && task.status !== "paused";
  const showPlan = task.steps.length > 1 || active;
  const approval = pendingApproval(live.events);

  // A finished task folds its working detail away and leaves the answer. The
  // open state is derived rather than stored, so a task that completes while
  // you are watching collapses on its own — until you say otherwise, and then
  // your choice sticks. A failed task stays open: that detail is the diagnosis.
  const finished = task.status === "completed";
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? !finished;

  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2.5">
          {task.agent ? (
            <span className="flex min-w-0 items-center gap-2">
              <AgentIcon
                slug={task.agent.slug}
                className="size-6 rounded-md [&_svg]:size-3.5"
              />
              <span className="truncate text-sm font-medium">
                {task.agent.name}
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <WandSparklesIcon className="size-4" /> Choosing an agent…
            </span>
          )}
          <TaskStatusBadge status={task.status} />
          <span className="ml-auto flex items-center gap-3">
            {active && <LiveIndicator state={live.streamState} />}
            {finished && (
              <button
                type="button"
                onClick={() => setOpenOverride(!open)}
                aria-expanded={open}
                className="inline-flex items-center gap-0.5 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {open ? "Hide steps" : "Show steps"}
                <ChevronRightIcon
                  className={cn(
                    "size-3.5 transition-transform",
                    open && "rotate-90",
                  )}
                />
              </button>
            )}
            <Link
              href={`/tasks/${task.id}`}
              className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Details <ArrowUpRightIcon className="size-3.5" />
            </Link>
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 px-3 py-3">
          {open && (
            <>
              {executing && live.statusText && (
                <p
                  className={cn(
                    "flex items-start gap-2 text-sm",
                    live.statusText.warning
                      ? "text-warning"
                      : "text-foreground",
                  )}
                >
                  <BrainCircuitIcon className="mt-0.5 size-4 shrink-0 animate-pulse text-brand" />
                  <span className="min-w-0">{live.statusText.text}</span>
                </p>
              )}

              {task.routing?.mode === "auto" &&
                task.routing.method !== "single" && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      Routing:
                    </span>{" "}
                    {task.routing.reason}
                  </p>
                )}

              {showPlan && task.steps.length > 0 && (
                <>
                  <StepList
                    steps={task.steps}
                    liveOutput={executing ? live.output : undefined}
                  />
                  {active && (
                    <TaskProgressBar
                      completed={task.progress.completed}
                      total={task.progress.total}
                    />
                  )}
                </>
              )}

              {approval && (
                <ApprovalPanel
                  approval={{
                    ...approval.data,
                    id: approval.data.approvalId,
                    agentName: task.agent?.name ?? null,
                  }}
                  onDecided={() => void live.refresh()}
                />
              )}
              {executing && live.browser.open && (
                <BrowserView
                  taskId={task.id}
                  live={live.browser}
                  screenshots={task.screenshots}
                  currentAction={currentBrowserAction(live.events)}
                  executing
                  compact
                />
              )}
              {executing && live.computer.open && (
                <ComputerView
                  taskId={task.id}
                  live={live.computer}
                  screenshots={task.screenshots}
                  currentAction={currentComputerAction(live.events)}
                  executing
                  compact
                />
              )}
              {executing &&
                task.toolCalls.some(
                  (c) =>
                    c.toolName === "terminal.run" && c.status === "running",
                ) && (
                  <TerminalView
                    toolCalls={task.toolCalls.filter(
                      (c) =>
                        c.toolName === "terminal.run" && c.status === "running",
                    )}
                    live={live.terminal}
                  />
                )}

              {task.status === "paused" && (
                <p className="text-sm text-muted-foreground">
                  Paused after {task.progress.completed} of{" "}
                  {task.progress.total} steps. Resume to continue with the next
                  step.
                </p>
              )}
            </>
          )}

          {!active && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {task.steps.length} step{task.steps.length === 1 ? "" : "s"} ·{" "}
              {formatDuration(task.durationMs)} ·{" "}
              {formatTokens(task.inputTokens + task.outputTokens)} tokens ·{" "}
              {formatCost(task.estimatedCostUsd)}
              {task.toolCalls.length
                ? ` · ${task.toolCalls.length} tool call${task.toolCalls.length === 1 ? "" : "s"}`
                : ""}
              {task.model ? ` · ${task.model}` : ""}
            </p>
          )}

          {open && live.events.length > 0 && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
                Live activity ({live.events.length} events)
              </summary>
              <ActivityTimeline
                events={live.events}
                compact
                scrollClassName="mt-2 max-h-56"
              />
            </details>
          )}

          {(active || task.status === "cancelled") && (
            <div className="flex flex-wrap gap-2">
              <TaskControls
                status={task.status}
                pauseRequested={task.pauseRequested}
                pendingAction={live.pendingAction}
                onAction={onAction}
              />
            </div>
          )}
        </div>
      </div>

      {task.status === "completed" && task.result && (
        <TaskResult result={task.result} />
      )}

      {task.status === "failed" && task.error && (
        <TaskErrorPanel error={task.error}>
          <TaskControls
            status={task.status}
            pauseRequested={false}
            pendingAction={live.pendingAction}
            onAction={onAction}
          />
        </TaskErrorPanel>
      )}
    </div>
  );
}

export function LiveIndicator({ state }: { state: StreamState }) {
  const label =
    state === "live"
      ? "Live"
      : state === "reconnecting"
        ? "Reconnecting"
        : state === "connecting"
          ? "Connecting"
          : null;
  if (!label) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "live"
            ? "animate-pulse bg-success"
            : state === "reconnecting"
              ? "bg-warning"
              : "bg-muted-foreground",
        )}
      />
      {label}
    </span>
  );
}
