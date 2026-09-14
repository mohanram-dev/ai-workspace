"use client";

import type { SubTaskDto } from "@aiw/shared";
import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { formatCost, formatDuration, formatTokens } from "@/lib/format";
import { AgentIcon } from "../agents/agent-icon";
import { TaskResult } from "./task-parts";
import { TaskStatusBadge } from "./task-status";

/** Work this task handed to other agents, each a real task of its own (spec §28). */
export function SubTasksView({ subTasks }: { subTasks: SubTaskDto[] }) {
  if (subTasks.length === 0) {
    return <p className="text-sm text-muted-foreground">This task has not delegated anything.</p>;
  }
  const tokens = subTasks.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0);
  const cost = subTasks.reduce((sum, s) => sum + (s.estimatedCostUsd ?? 0), 0);

  return (
    <ol className="grid gap-3">
      <li className="text-xs tabular-nums text-muted-foreground">
        {subTasks.length} delegated task(s) · {formatTokens(tokens)} tokens · {formatCost(cost)}. This is on top of what the task above spent itself.
      </li>
      {subTasks.map((sub, index) => (
        <li key={sub.id} className="min-w-0 rounded-lg border bg-background">
          <div className="flex flex-wrap items-start gap-3 border-b px-4 py-3">
            <span className="mt-0.5 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
            {sub.agent && <AgentIcon slug={sub.agent.slug} />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{sub.agent?.name ?? "Unknown agent"}</span>
                <TaskStatusBadge status={sub.status} />
              </div>
              <p className="mt-1 text-sm whitespace-pre-wrap break-words text-muted-foreground">{sub.prompt}</p>
            </div>
            <Link href={`/tasks/${sub.id}`} className="inline-flex shrink-0 items-center gap-1 text-xs underline underline-offset-2">
              Open <ArrowUpRightIcon className="size-3" />
            </Link>
          </div>
          <div className="px-4 py-3">
            {sub.error ? (
              <p className="text-sm text-destructive">{sub.error.message}</p>
            ) : sub.result ? (
              <TaskResult result={sub.result} />
            ) : (
              <p className="text-sm text-muted-foreground">No result yet.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
              <span>{formatTokens(sub.inputTokens + sub.outputTokens)} tokens</span>
              {sub.estimatedCostUsd !== null && <span>{formatCost(sub.estimatedCostUsd)}</span>}
              {sub.durationMs !== null && <span>{formatDuration(sub.durationMs)}</span>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
