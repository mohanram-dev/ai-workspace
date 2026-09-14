"use client";

import {
  ACTIVITY_RANGES,
  ACTIVITY_RANGE_LABELS,
  type ActivityDto,
  type ActivityRange,
  type TaskEvent,
} from "@aiw/shared";
import { ActivityIcon, AlertTriangleIcon, BotIcon, CircleDollarSignIcon, CpuIcon, ListChecksIcon, WrenchIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { formatCost, formatDuration, formatRelativeTime, formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";

const MAX_FEED = 60;

/** The observability dashboard: what the agents did, what it cost, and what is happening now. */
export function ActivityPage() {
  const [range, setRange] = useState<ActivityRange>("7d");
  const [data, setData] = useState<ActivityDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [live, setLive] = useState(false);

  const load = useCallback((value: ActivityRange, active: () => boolean = () => true) => {
    apiFetch<ActivityDto>(`/api/activity?range=${value}`)
      .then((next) => {
        if (!active()) return;
        setData(next);
        setError(null);
      })
      .catch((e: unknown) => active() && setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    let active = true;
    load(range, () => active);
    return () => {
      active = false;
    };
  }, [range, load]);

  // The live feed doubles as the refresh trigger: when something finishes, the
  // numbers above it are stale, so they are re-read rather than polled blindly.
  const reload = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const source = new EventSource("/api/activity/events");
    source.addEventListener("open", () => setLive(true));
    source.addEventListener("error", () => setLive(false));
    source.addEventListener("activity", (message) => {
      setLive(true);
      let event: TaskEvent;
      try {
        event = JSON.parse((message as MessageEvent<string>).data) as TaskEvent;
      } catch {
        return;
      }
      setEvents((current) => [event, ...current.filter((e) => e.id !== event.id)].slice(0, MAX_FEED));
      if (event.type === "TASK_COMPLETED" || event.type === "TASK_FAILED" || event.type === "TASK_CANCELLED") {
        clearTimeout(reload.current);
        reload.current = setTimeout(() => load(range), 800);
      }
    });
    return () => {
      source.close();
      clearTimeout(reload.current);
    };
  }, [range, load]);

  const current = data?.range === range ? data : null;
  const totals = current?.totals;

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              What your agents have done, what it cost, and what is happening right now. Every figure is read from recorded runs.
            </p>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Time range">
            {ACTIVITY_RANGES.map((value) => (
              <Button key={value} size="sm" variant={value === range ? "secondary" : "ghost"} onClick={() => setRange(value)}>
                {ACTIVITY_RANGE_LABELS[value]}
              </Button>
            ))}
          </div>
        </div>

        {error ? (
          <p className="mt-6 text-sm text-destructive">{error}</p>
        ) : !totals ? (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat icon={ListChecksIcon} label="Tasks" value={String(totals.tasks)} hint={`${totals.completed} completed · ${totals.failed} failed`} />
              <Stat
                icon={ActivityIcon}
                label="Success rate"
                value={totals.successRate === null ? "—" : `${Math.round(totals.successRate * 100)}%`}
                hint={totals.successRate === null ? "Nothing has finished yet" : `${totals.cancelled} cancelled`}
              />
              <Stat icon={BotIcon} label="Agents used" value={String(totals.activeAgents)} hint={totals.running > 0 ? `${totals.running} task(s) running now` : "Nothing running"} />
              <Stat icon={CpuIcon} label="Average run" value={formatDuration(totals.avgDurationMs)} hint="Finished tasks only" />
              <Stat
                icon={CircleDollarSignIcon}
                label="Estimated cost"
                value={formatCost(totals.estimatedCostUsd)}
                hint={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`}
              />
              <Stat
                icon={WrenchIcon}
                label="Tool calls"
                value={String(totals.toolCalls)}
                hint={totals.failedToolCalls > 0 ? `${totals.failedToolCalls} failed or denied` : "All succeeded"}
              />
              <Stat icon={AlertTriangleIcon} label="Failures" value={String(totals.failed)} hint={current.errors.length > 0 ? `${current.errors.length} distinct error(s)` : "No failures"} />
              <Stat icon={ActivityIcon} label="Live feed" value={live ? "Connected" : "Offline"} hint={live ? "Events arrive as they happen" : "Reconnecting…"} />
            </div>

            {current.daily.length > 1 && <DailyChart daily={current.daily} />}

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <Card title="By agent">
                {current.agents.length === 0 ? (
                  <Empty>No agent has run a task in this period.</Empty>
                ) : (
                  <Table
                    head={["Agent", "Tasks", "Avg", "Cost"]}
                    rows={current.agents.map((a) => [
                      <Link key="n" href={`/agents/${a.agentId}`} className="font-medium hover:underline">
                        {a.agentName}
                      </Link>,
                      <span key="t">
                        {a.tasks}
                        {a.failed > 0 && <span className="text-destructive"> · {a.failed} failed</span>}
                      </span>,
                      formatDuration(a.avgDurationMs),
                      formatCost(a.estimatedCostUsd),
                    ])}
                  />
                )}
              </Card>

              <Card title="By model">
                {current.models.length === 0 ? (
                  <Empty>No model calls recorded in this period.</Empty>
                ) : (
                  <Table
                    head={["Model", "Purpose", "Calls", "Tokens", "Cost"]}
                    rows={current.models.map((m) => [
                      <span key="m" className="font-mono text-xs">
                        {m.model}
                      </span>,
                      <Badge key="p" variant="outline" className="text-[0.6rem]">
                        {m.purpose}
                      </Badge>,
                      String(m.calls),
                      formatTokens(m.inputTokens + m.outputTokens),
                      formatCost(m.estimatedCostUsd),
                    ])}
                  />
                )}
              </Card>

              <Card title="By tool">
                {current.tools.length === 0 ? (
                  <Empty>No tools were called in this period.</Empty>
                ) : (
                  <Table
                    head={["Tool", "Calls", "Failed", "Avg"]}
                    rows={current.tools.map((t) => [
                      <span key="t" className="font-mono text-xs">
                        {t.toolName}
                      </span>,
                      String(t.calls),
                      <span key="f" className={cn(t.failed + t.denied > 0 && "text-destructive")}>
                        {t.failed + t.denied > 0 ? `${t.failed + t.denied}` : "—"}
                      </span>,
                      formatDuration(t.avgDurationMs),
                    ])}
                  />
                )}
              </Card>

              <Card title="Errors">
                {current.errors.length === 0 ? (
                  <Empty>No task failed in this period.</Empty>
                ) : (
                  <Table
                    head={["Error", "Times", "Last"]}
                    rows={current.errors.map((e) => [e.title, String(e.count), formatRelativeTime(e.lastAt)])}
                  />
                )}
              </Card>
            </div>

            <div className="mt-6">
              <Card
                title="Live event stream"
                action={
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={cn("size-1.5 rounded-full", live ? "animate-pulse bg-success" : "bg-muted-foreground/40")} />
                    {live ? "live" : "offline"}
                  </span>
                }
              >
                {events.length === 0 ? (
                  <Empty>Nothing yet. Events appear here the moment an agent records one.</Empty>
                ) : (
                  <ol className="grid gap-1.5">
                    {events.map((event) => (
                      <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                        <span className="font-mono text-[0.65rem] text-muted-foreground tabular-nums">
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "shrink-0 font-mono text-[0.6rem]",
                            event.status === "error" && "border-destructive/40 text-destructive",
                            event.status === "warning" && "border-warning/40",
                            event.status === "success" && "border-success/40",
                          )}
                        >
                          {event.type}
                        </Badge>
                        {event.agent && <span className="text-xs text-muted-foreground">{event.agent.name}</span>}
                        <Link href={`/tasks/${event.taskId}`} className="min-w-0 flex-1 truncate hover:underline">
                          {event.description}
                        </Link>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Tasks per day. A plain bar chart in CSS: no chart library for four numbers a day. */
function DailyChart({ daily }: { daily: ActivityDto["daily"] }) {
  const max = Math.max(...daily.map((d) => d.total), 1);
  return (
    <div className="mt-6 rounded-xl border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold">Tasks per day</h2>
      <div className="scrollbar-thin mt-4 overflow-x-auto">
        <div className="flex min-w-fit items-end gap-1.5" style={{ height: 120 }}>
          {daily.map((day) => {
            const failedShare = day.total > 0 ? day.failed / day.total : 0;
            return (
              <div key={day.day} className="flex w-8 flex-col items-center gap-1.5">
                <span className="text-[0.6rem] text-muted-foreground tabular-nums">{day.total}</span>
                <div
                  className="flex w-full flex-col justify-end overflow-hidden rounded-sm bg-muted"
                  style={{ height: `${Math.max((day.total / max) * 88, 3)}px` }}
                  title={`${day.day}: ${day.total} task(s), ${day.completed} completed, ${day.failed} failed`}
                >
                  {day.failed > 0 && <span className="w-full bg-destructive/70" style={{ height: `${failedShare * 100}%` }} />}
                </div>
                <span className="text-[0.6rem] text-muted-foreground">{day.day.slice(5)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, hint }: { icon: typeof ActivityIcon; label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            {head.map((h) => (
              <th key={h} className="py-2 pr-3 font-medium last:pr-0">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="min-w-0 py-2 pr-3 tabular-nums last:pr-0">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
