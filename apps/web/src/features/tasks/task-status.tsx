import type { TaskStatus, TaskStepStatus } from "@aiw/shared";
import {
  BanIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  ClockIcon,
  Loader2Icon,
  PauseIcon,
  ShieldAlertIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS: Record<TaskStatus, { label: string; icon: LucideIcon; className: string; spin?: boolean }> = {
  queued: { label: "Queued", icon: ClockIcon, className: "border-border bg-muted text-muted-foreground" },
  planning: { label: "Planning", icon: Loader2Icon, className: "border-brand/30 bg-brand/10 text-brand", spin: true },
  running: { label: "Running", icon: Loader2Icon, className: "border-brand/30 bg-brand/10 text-brand", spin: true },
  waiting_for_tool: { label: "Waiting for tool", icon: WrenchIcon, className: "border-warning/40 bg-warning/10 text-foreground" },
  waiting_for_approval: { label: "Waiting for approval", icon: ShieldAlertIcon, className: "border-warning/40 bg-warning/10 text-foreground" },
  paused: { label: "Paused", icon: PauseIcon, className: "border-border bg-muted text-muted-foreground" },
  completed: { label: "Completed", icon: CheckIcon, className: "border-success/40 bg-success/10 text-foreground" },
  failed: { label: "Failed", icon: XIcon, className: "border-destructive/40 bg-destructive/10 text-destructive" },
  cancelled: { label: "Cancelled", icon: BanIcon, className: "border-border bg-muted text-muted-foreground" },
};

export function TaskStatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const { label, icon: Icon, className: tone, spin } = STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        tone,
        className,
      )}
    >
      <Icon className={cn("size-3.5", spin && "animate-spin")} />
      {label}
    </span>
  );
}

export function StepStatusIcon({ status, className }: { status: TaskStepStatus; className?: string }) {
  switch (status) {
    case "completed":
      return (
        <span className={cn("flex size-5 items-center justify-center rounded-full bg-success/15 text-success", className)} aria-label="Completed">
          <CheckIcon className="size-3.5" />
        </span>
      );
    case "running":
      return (
        <span className={cn("flex size-5 items-center justify-center text-brand", className)} aria-label="Running">
          <Loader2Icon className="size-4 animate-spin" />
        </span>
      );
    case "failed":
      return (
        <span className={cn("flex size-5 items-center justify-center rounded-full bg-destructive/15 text-destructive", className)} aria-label="Failed">
          <XIcon className="size-3.5" />
        </span>
      );
    case "cancelled":
      return (
        <span className={cn("flex size-5 items-center justify-center text-muted-foreground", className)} aria-label="Cancelled">
          <CircleDashedIcon className="size-4" />
        </span>
      );
    default:
      return (
        <span className={cn("flex size-5 items-center justify-center text-muted-foreground/60", className)} aria-label="Pending">
          <CircleIcon className="size-3.5" />
        </span>
      );
  }
}
