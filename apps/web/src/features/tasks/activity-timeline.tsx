"use client";

import type { TaskEvent } from "@aiw/shared";
import {
  BanIcon,
  FileIcon,
  FilePenIcon,
  FilePlusIcon,
  GlobeIcon,
  PlugIcon,
  AppWindowIcon,
  CameraIcon,
  MousePointerClickIcon,
  NavigationIcon,
  MonitorIcon,
  MousePointer2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  SquareTerminalIcon,
  WrenchIcon,
  BotIcon,
  UsersIcon,
  ZapIcon,
  MessageSquareIcon,
  BrainCircuitIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  CpuIcon,
  FlagIcon,
  ListTreeIcon,
  PauseCircleIcon,
  PlayCircleIcon,
  PlusCircleIcon,
  RouteIcon,
  TrendingUpIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const ICONS: Record<TaskEvent["type"], LucideIcon> = {
  TASK_CREATED: PlusCircleIcon,
  AGENT_SELECTED: RouteIcon,
  AGENT_STARTED: BotIcon,
  THINKING_STATUS: BrainCircuitIcon,
  PLAN_CREATED: ListTreeIcon,
  STEP_STARTED: CircleDotIcon,
  STEP_COMPLETED: CheckCircle2Icon,
  STEP_FAILED: XCircleIcon,
  TASK_PROGRESS: TrendingUpIcon,
  MODEL_CALL_FINISHED: CpuIcon,
  TOOL_CALL_STARTED: WrenchIcon,
  TOOL_CALL_FINISHED: WrenchIcon,
  FILE_READ: FileIcon,
  FILE_CREATED: FilePlusIcon,
  FILE_UPDATED: FilePenIcon,
  TERMINAL_COMMAND_STARTED: SquareTerminalIcon,
  TERMINAL_COMMAND_FINISHED: SquareTerminalIcon,
  PAGE_READ: GlobeIcon,
  MCP_TOOL_STARTED: PlugIcon,
  MCP_TOOL_FINISHED: PlugIcon,
  BROWSER_OPENED: AppWindowIcon,
  PAGE_NAVIGATED: NavigationIcon,
  BROWSER_ACTION: MousePointerClickIcon,
  BROWSER_SCREENSHOT: CameraIcon,
  BROWSER_CLOSED: AppWindowIcon,
  COMPUTER_STARTED: MonitorIcon,
  COMPUTER_ACTION: MousePointer2Icon,
  COMPUTER_SCREENSHOT: CameraIcon,
  COMPUTER_STOPPED: MonitorIcon,
  APPROVAL_REQUIRED: ShieldAlertIcon,
  APPROVAL_GRANTED: ShieldCheckIcon,
  APPROVAL_REJECTED: ShieldXIcon,
  AUTONOMOUS_ACTION: ZapIcon,
  AGENT_MESSAGE: MessageSquareIcon,
  TASK_DELEGATED: UsersIcon,
  SUBTASK_FINISHED: BotIcon,
  TASK_PAUSE_REQUESTED: PauseCircleIcon,
  TASK_PAUSED: PauseCircleIcon,
  TASK_RESUMED: PlayCircleIcon,
  TASK_COMPLETED: FlagIcon,
  TASK_FAILED: XCircleIcon,
  TASK_CANCELLED: BanIcon,
};

const TONE: Record<TaskEvent["status"], string> = {
  info: "text-muted-foreground",
  running: "text-brand",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

interface ActivityTimelineProps {
  events: TaskEvent[];
  /** Hide low-level events (progress, model calls) for a compact feed. */
  compact?: boolean;
  /** Scrollable height class (e.g. "max-h-64"); the newest event stays in view within it. */
  scrollClassName?: string;
  className?: string;
  emptyText?: string;
}

const COMPACT_HIDDEN = new Set<TaskEvent["type"]>(["TASK_PROGRESS", "MODEL_CALL_FINISHED"]);

/** Chronological execution timeline: timestamp, icon, description, duration. */
export function ActivityTimeline({ events, compact = false, scrollClassName, className, emptyText = "No activity yet." }: ActivityTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const visible = compact ? events.filter((e) => !COMPACT_HIDDEN.has(e.type)) : events;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  if (visible.length === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;

  const list = (
    <ol className={cn("grid grid-cols-1", className)} aria-live="polite" aria-relevant="additions">
      {visible.map((event, index) => {
        const Icon = ICONS[event.type];
        const last = index === visible.length - 1;
        return (
          <li key={event.id} className="relative flex gap-3 pb-3 last:pb-0">
            {!last && <span aria-hidden className="absolute top-6 bottom-0 left-[0.6875rem] w-px bg-border" />}
            <span className={cn("relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-card", TONE[event.status])}>
              <Icon className={cn("size-4", event.status === "running" && event.type === "THINKING_STATUS" && last && "animate-pulse")} />
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm break-words", event.status === "error" && "text-destructive")}>{event.description}</p>
              <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground tabular-nums">
                <time dateTime={event.timestamp}>{timeFormatter.format(new Date(event.timestamp))}</time>
                {event.agent && !compact && <span>{event.agent.name}</span>}
                {event.durationMs !== null && <span>{formatDuration(event.durationMs)}</span>}
                {!compact && <span className="font-mono text-[0.65rem] uppercase">{event.type}</span>}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );

  if (!scrollClassName) return list;
  return (
    <div ref={scrollRef} className={cn("scrollbar-thin overflow-y-auto pr-1", scrollClassName)}>
      {list}
    </div>
  );
}
