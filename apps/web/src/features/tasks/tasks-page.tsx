"use client";

import { isActiveTaskStatus, type TaskDto } from "@aiw/shared";
import { ListChecksIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api-client";
import { formatCost, formatDuration, formatRelativeTime, formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentIcon } from "../agents/agent-icon";
import { fetchTasks, type TaskFilter } from "./api";
import { TaskStatusBadge } from "./task-status";

const FILTERS: { value: TaskFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

export function TasksPage() {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [tasks, setTasks] = useState<TaskDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTasks(await fetchTasks(filter));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [filter]);

  useEffect(() => {
    // Load on mount and whenever the filter changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const anyActive = tasks?.some((t) => isActiveTaskStatus(t.status)) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [anyActive, load]);

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="mt-1 text-sm text-muted-foreground">Every agent execution with its status, usage and result.</p>

        <div role="tablist" aria-label="Task filter" className="mt-6 flex flex-wrap gap-1">
          {FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => {
                setFilter(value);
                setTasks(null);
              }}
              className={cn(
                "rounded-full border px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
                filter === value && "border-foreground/20 bg-foreground text-background hover:text-background",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border bg-card">
          {error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : tasks === null ? (
            <div className="grid gap-3 p-4">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
              <ListChecksIcon className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {filter === "all" ? "No tasks yet. Give an agent a task from the chat." : "No tasks match this filter."}
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {tasks.map((task) => (
                <li key={task.id}>
                  <Link href={`/tasks/${task.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
                    {task.agent ? (
                      <AgentIcon slug={task.agent.slug} />
                    ) : (
                      <span className="size-8 shrink-0 rounded-lg bg-muted" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{task.prompt}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {task.agent?.name ?? "Unrouted"}
                        {task.model ? ` · ${task.model}` : ""} · {formatRelativeTime(task.createdAt)}
                        {task.attempt > 1 ? ` · attempt ${task.attempt}` : ""}
                        {task.parentTaskId ? " · delegated" : ""}
                      </p>
                    </div>
                    <div className="hidden shrink-0 text-right text-xs text-muted-foreground tabular-nums md:block">
                      <p>{formatDuration(task.durationMs)}</p>
                      <p>
                        {formatTokens(task.inputTokens + task.outputTokens)} tok · {formatCost(task.estimatedCostUsd)}
                      </p>
                    </div>
                    <TaskStatusBadge status={task.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
