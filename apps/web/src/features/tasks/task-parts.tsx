"use client";

import type { TaskError, TaskStatus, TaskStepDto } from "@aiw/shared";
import { AlertTriangleIcon, ChevronRightIcon, Loader2Icon, PauseIcon, PlayIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/format";
import type { TaskAction } from "./api";
import { cn } from "@/lib/utils";
import { Markdown } from "../chat/markdown";
import { StepStatusIcon } from "./task-status";

export function TaskProgressBar({ completed, total, className }: { completed: number; total: number; className?: string }) {
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Task progress"
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
      <span className="w-9 text-right text-xs text-muted-foreground tabular-nums">{percent}%</span>
    </div>
  );
}

/** Plan steps with live status. `expandable` shows each step's output on demand; `liveOutput` streams the running step. */
export function StepList({
  steps,
  expandable = false,
  liveOutput,
}: {
  steps: TaskStepDto[];
  expandable?: boolean;
  liveOutput?: Record<string, string>;
}) {
  if (steps.length === 0) return null;
  return (
    <ol className="grid grid-cols-1 gap-1">
      {steps.map((step) => {
        const hasDetail = expandable && (step.output || step.error);
        const header = (
          <span className="flex min-w-0 items-center gap-2.5">
            <StepStatusIcon status={step.status} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                step.status === "pending" && "text-muted-foreground",
                step.status === "running" && "font-medium",
              )}
            >
              {step.title}
            </span>
            {step.durationMs !== null && (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDuration(step.durationMs)}</span>
            )}
          </span>
        );

        const streaming = step.status === "running" ? liveOutput?.[step.id] : undefined;
        if (!hasDetail) {
          return (
            <li key={step.id} className="py-1">
              {header}
              {streaming !== undefined && <LiveOutput text={streaming} className="mt-2 ml-7.5" />}
            </li>
          );
        }
        return (
          <li key={step.id}>
            <details className="group rounded-lg [&[open]]:bg-muted/40">
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded-lg py-1 pr-2 hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 flex-1">{header}</span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              </summary>
              <div className="border-t px-3 py-3">
                <p className="mb-2 text-xs text-muted-foreground">{step.instruction}</p>
                {step.error && <p className="text-sm text-destructive">{step.error}</p>}
                {step.output && <Markdown content={step.output} className="text-sm" />}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

/** Readable failure report (spec §40) with the raw detail tucked away. */
export function TaskErrorPanel({ error, children }: { error: TaskError; children?: ReactNode }) {
  return (
    <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{error.title}</p>
          <dl className="mt-2 grid gap-1.5 sm:grid-cols-[7rem_1fr]">
            {error.stepTitle && (
              <>
                <dt className="text-muted-foreground">Step</dt>
                <dd>
                  {error.stepIndex !== null ? `${error.stepIndex + 1}. ` : ""}
                  {error.stepTitle}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">What happened</dt>
            <dd>{error.message}</dd>
            <dt className="text-muted-foreground">Next step</dt>
            <dd>{error.suggestedAction}</dd>
          </dl>
          {error.detail && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Technical detail</summary>
              <code className="mt-1 block rounded bg-muted px-2 py-1 font-mono text-xs break-all">
                {error.code}: {error.detail}
              </code>
            </details>
          )}
          {children && <div className="mt-3 flex flex-wrap gap-2">{children}</div>}
        </div>
      </div>
    </div>
  );
}

/** Model output streaming for the running step; keeps the newest text in view. */
export function LiveOutput({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div
      ref={ref}
      aria-live="off"
      className={cn(
        "scrollbar-thin max-h-48 overflow-y-auto rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground",
        className,
      )}
    >
      {text ? (
        <p className="font-mono whitespace-pre-wrap break-words">
          {text}
          <span aria-hidden className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-brand align-middle" />
        </p>
      ) : (
        <p className="flex items-center gap-1.5">
          <Loader2Icon className="size-3.5 animate-spin" /> Waiting for model output…
        </p>
      )}
    </div>
  );
}

export function TaskResult({ result }: { result: string }) {
  return <Markdown content={result} />;
}

interface TaskControlsProps {
  status: TaskStatus;
  pauseRequested: boolean;
  pendingAction: TaskAction | null;
  onAction: (action: TaskAction) => void;
  size?: "sm" | "default";
}

export function TaskControls({ status, pauseRequested, pendingAction, onAction, size = "sm" }: TaskControlsProps) {
  const executing = status === "queued" || status === "planning" || status === "running";
  const busy = pendingAction !== null;
  return (
    <>
      {executing && (
        <Button variant="outline" size={size} onClick={() => onAction("pause")} disabled={busy || pauseRequested}>
          {pauseRequested ? <Loader2Icon className="animate-spin" /> : <PauseIcon className="fill-current" />}
          {pauseRequested ? "Pausing after this step…" : "Pause"}
        </Button>
      )}
      {status === "paused" && (
        <Button variant="default" size={size} onClick={() => onAction("resume")} disabled={busy}>
          <PlayIcon /> Resume
        </Button>
      )}
      {(executing || status === "paused") && (
        <Button variant="outline" size={size} onClick={() => onAction("stop")} disabled={busy}>
          <SquareIcon className="fill-current" /> Stop
        </Button>
      )}
      {(status === "failed" || status === "cancelled") && (
        <Button variant="default" size={size} onClick={() => onAction("continue")} disabled={busy}>
          <PlayIcon /> {status === "failed" ? "Ask agent to fix" : "Continue"}
        </Button>
      )}
      {(status === "completed" || status === "failed" || status === "cancelled") && (
        <Button variant="outline" size={size} onClick={() => onAction("retry")} disabled={busy}>
          <RotateCcwIcon /> Retry
        </Button>
      )}
    </>
  );
}
