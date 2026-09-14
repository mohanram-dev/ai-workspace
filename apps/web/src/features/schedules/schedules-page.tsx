"use client";

import type { AgentDto, ProjectDto, ScheduleDto, ScheduleRunDto, ScheduleWithRunsDto } from "@aiw/shared";
import { CalendarClockIcon, ChevronDownIcon, ChevronRightIcon, Loader2Icon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ScheduleForm } from "./schedule-form";

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Schedules that run agents on their own, with their run history (spec §26). */
export function SchedulesPage() {
  const router = useRouter();
  const [schedules, setSchedules] = useState<ScheduleDto[] | null>(null);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, ScheduleRunDto[]>>({});
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch<{ schedules: ScheduleDto[] }>("/api/schedules"),
      apiFetch<{ agents: AgentDto[] }>("/api/agents"),
      apiFetch<{ projects: ProjectDto[] }>("/api/projects"),
    ])
      .then(([s, a, p]) => {
        if (!active) return;
        setSchedules(s.schedules);
        setAgents(a.agents.filter((agent) => agent.enabled));
        setProjects(p.projects);
      })
      .catch((e: unknown) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, []);

  async function toggle(schedule: ScheduleDto, enabled: boolean) {
    setSchedules((current) => current?.map((s) => (s.id === schedule.id ? { ...s, enabled } : s)) ?? null);
    try {
      const updated = await apiFetch<ScheduleDto>(`/api/schedules/${schedule.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      setSchedules((current) => current?.map((s) => (s.id === schedule.id ? updated : s)) ?? null);
    } catch (e) {
      setSchedules((current) => current?.map((s) => (s.id === schedule.id ? schedule : s)) ?? null);
      toast.error(errorMessage(e));
    }
  }

  async function runNow(schedule: ScheduleDto) {
    setRunning(schedule.id);
    try {
      const result = await apiFetch<{ taskId: string }>(`/api/schedules/${schedule.id}/run`, { method: "POST" });
      toast.success(`${schedule.name} started`, { action: { label: "Open task", onClick: () => router.push(`/tasks/${result.taskId}`) } });
      await openRuns(schedule.id, true);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRunning(null);
    }
  }

  async function openRuns(id: string, force = false) {
    if (!force && expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    try {
      const detail = await apiFetch<ScheduleWithRunsDto>(`/api/schedules/${id}`);
      setRuns((current) => ({ ...current, [id]: detail.runs }));
      setSchedules((current) => current?.map((s) => (s.id === id ? detail : s)) ?? null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove(schedule: ScheduleDto) {
    const previous = schedules;
    setSchedules((current) => current?.filter((s) => s.id !== schedule.id) ?? null);
    try {
      await apiFetch(`/api/schedules/${schedule.id}`, { method: "DELETE" });
    } catch (e) {
      setSchedules(previous);
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Schedules</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Give an agent a task to run on its own: every morning, every Monday, or on a cron expression. Each run starts a normal task you can open.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setCreating((v) => !v);
              setEditing(null);
            }}
          >
            <PlusIcon /> New schedule
          </Button>
        </div>

        {creating && (
          <div className="mt-4">
            <ScheduleForm
              agents={agents}
              projects={projects}
              onCancel={() => setCreating(false)}
              onSaved={(schedule) => {
                setSchedules((current) => [...(current ?? []), schedule].sort((a, b) => a.name.localeCompare(b.name)));
                setCreating(false);
              }}
            />
          </div>
        )}

        {error ? (
          <p className="mt-6 text-sm text-destructive">{error}</p>
        ) : schedules === null ? (
          <div className="mt-6 grid gap-3">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : schedules.length === 0 && !creating ? (
          <div className="mt-6 rounded-xl border border-dashed px-6 py-10 text-center">
            <CalendarClockIcon className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 font-medium">No schedules yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              For example: every weekday at 08:00, research AI news and write a summary.
            </p>
          </div>
        ) : (
          <ul className="mt-6 grid gap-3">
            {schedules.map((schedule) => (
              <li key={schedule.id} className={cn("rounded-xl border bg-card", !schedule.enabled && "opacity-70")}>
                <div className="flex flex-wrap items-start gap-3 p-4">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                    <CalendarClockIcon className="size-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-words">{schedule.name}</span>
                      <Badge variant="outline" className="text-[0.65rem]">
                        {schedule.description}
                      </Badge>
                      {schedule.agent && (
                        <Badge variant="secondary" className="text-[0.65rem]">
                          {schedule.agent.name}
                        </Badge>
                      )}
                      {schedule.projectName && (
                        <Badge variant="secondary" className="text-[0.65rem]">
                          {schedule.projectName}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{schedule.prompt}</p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{schedule.nextRunAt ? `Next: ${dateFormatter.format(new Date(schedule.nextRunAt))}` : "Not scheduled"}</span>
                      {schedule.lastRunAt && <span>Last: {formatRelativeTime(schedule.lastRunAt)}</span>}
                      <span>{schedule.runCount} run(s)</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={schedule.enabled}
                      onCheckedChange={(on) => void toggle(schedule, on)}
                      aria-label={`${schedule.enabled ? "Disable" : "Enable"} ${schedule.name}`}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 border-t px-4 py-2">
                  <Button size="sm" variant="outline" disabled={running === schedule.id} onClick={() => void runNow(schedule)}>
                    {running === schedule.id ? <Loader2Icon className="animate-spin" /> : <PlayIcon />} Run now
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void openRuns(schedule.id)}>
                    {expanded === schedule.id ? <ChevronDownIcon /> : <ChevronRightIcon />} History
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(editing === schedule.id ? null : schedule.id)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" className="ml-auto" aria-label={`Delete ${schedule.name}`} onClick={() => void remove(schedule)}>
                    <Trash2Icon />
                  </Button>
                </div>

                {editing === schedule.id && (
                  <div className="border-t p-4">
                    <ScheduleForm
                      schedule={schedule}
                      agents={agents}
                      projects={projects}
                      onCancel={() => setEditing(null)}
                      onSaved={(updated) => {
                        setSchedules((current) => current?.map((s) => (s.id === updated.id ? updated : s)) ?? null);
                        setEditing(null);
                      }}
                    />
                  </div>
                )}

                {expanded === schedule.id && (
                  <div className="border-t px-4 py-3">
                    {!runs[schedule.id] ? (
                      <Skeleton className="h-12 rounded-md" />
                    ) : runs[schedule.id]!.length === 0 ? (
                      <p className="text-sm text-muted-foreground">It has not run yet.</p>
                    ) : (
                      <ul className="grid gap-1 text-sm">
                        {runs[schedule.id]!.map((run) => (
                          <li key={run.id} className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[0.6rem]",
                                run.status === "started" && "border-success/40 bg-success/10",
                                run.status === "failed" && "border-destructive/40 text-destructive",
                              )}
                            >
                              {run.status}
                            </Badge>
                            <span className="text-xs text-muted-foreground">{dateFormatter.format(new Date(run.scheduledFor))}</span>
                            {run.taskId && (
                              <Link href={`/tasks/${run.taskId}`} className="text-xs underline underline-offset-2">
                                Open task
                              </Link>
                            )}
                            {run.detail && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{run.detail}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
