"use client";

import type { AgentDto } from "@aiw/shared";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { AgentIcon } from "./agent-icon";
import { useAgents } from "./use-agents";

const PLANNING_LABEL = { auto: "Plans when needed", always: "Always plans", never: "No planning" } as const;

export function AgentsPage({ defaultModel }: { defaultModel: string | null }) {
  const { agents, loading, error, setAgents } = useAgents({ refreshMs: 5000 });

  async function toggle(agent: AgentDto, enabled: boolean) {
    setAgents((current) => current?.map((a) => (a.id === agent.id ? { ...a, enabled } : a)) ?? null);
    try {
      const updated = await apiFetch<AgentDto>(`/api/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      setAgents((current) => current?.map((a) => (a.id === agent.id ? updated : a)) ?? null);
    } catch (e) {
      setAgents((current) => current?.map((a) => (a.id === agent.id ? agent : a)) ?? null);
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Specialised agents that plan and carry out tasks. Auto-routing picks the best enabled agent for each task.
            </p>
          </div>
          <Button asChild>
            <Link href="/agents/new">
              <PlusIcon /> New agent
            </Link>
          </Button>
        </div>

        <div className="mt-4 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
          <span className="font-medium">Agents act only through their assigned tools.</span>{" "}
          <span className="text-muted-foreground">
            Files, git, terminal, web and MCP tools run within granted permissions; built-in tools work inside a private per-user workspace.
            The Browser Agent drives a real headless browser; the Computer Use Agent controls the server&apos;s desktop when enabled. Destructive actions pause the task and ask you to approve them.
          </span>
        </div>

        {error ? (
          <p className="mt-6 text-sm text-destructive">{error}</p>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {loading
              ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-44 rounded-xl" />)
              : agents.map((agent) => (
                  <div
                    key={agent.id}
                    className={cn(
                      "group relative flex flex-col rounded-xl border bg-card p-4 transition-colors hover:border-ring/40",
                      !agent.enabled && "opacity-70",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <AgentIcon slug={agent.slug} />
                      <div className="min-w-0 flex-1">
                        <Link href={`/agents/${agent.id}`} className="font-medium after:absolute after:inset-0 hover:underline">
                          {agent.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          <AgentStatusBadge status={agent.status} activeTasks={agent.activeTasks} enabled={agent.enabled} />
                          {agent.builtin && <Badge variant="secondary" className="text-[0.65rem]">Built-in</Badge>}
                          {!agent.routable && <Badge variant="outline" className="text-[0.65rem]">Manual only</Badge>}
                        </div>
                      </div>
                      <Switch
                        checked={agent.enabled}
                        onCheckedChange={(checked) => void toggle(agent, checked)}
                        aria-label={`${agent.enabled ? "Disable" : "Enable"} ${agent.name}`}
                        className="relative z-10"
                      />
                    </div>
                    <p className="mt-3 line-clamp-3 flex-1 text-sm text-muted-foreground">{agent.description}</p>
                    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono">{agent.model ?? `${defaultModel ?? "default"} (default)`}</span>
                      <span>{PLANNING_LABEL[agent.planningMode]}</span>
                      <span>≤ {agent.maxSteps} steps</span>
                      <span>{agent.tools.length ? `${agent.tools.length} tool${agent.tools.length === 1 ? "" : "s"}` : "No tools"}</span>
                      {agent.dailyBudgetUsd !== null && <span>${agent.dailyBudgetUsd}/day</span>}
                    </div>
                  </div>
                ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentStatusBadge({ status, activeTasks, enabled }: Pick<AgentDto, "status" | "activeTasks" | "enabled">) {
  if (!enabled) return <Badge variant="outline" className="text-[0.65rem]">Disabled</Badge>;
  const label = status === "running" ? `Running · ${activeTasks}` : status === "paused" ? "Paused" : "Idle";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 text-[0.65rem]",
        status === "running" && "border-brand/40 bg-brand/10 text-brand",
        status === "paused" && "border-warning/40 bg-warning/10 text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full bg-muted-foreground/50", status === "running" && "animate-pulse bg-brand", status === "paused" && "bg-warning")}
      />
      {label}
    </Badge>
  );
}
