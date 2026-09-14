"use client";

import type { AgentDto, ProjectDto, ScheduleDto, ScheduleTrigger } from "@aiw/shared";
import { Loader2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, errorMessage } from "@/lib/api-client";

const AUTO_AGENT = "__auto__";
const NO_PROJECT = "__none__";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const TRIGGER_LABELS: Record<ScheduleTrigger, string> = {
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
  interval: "Every N minutes",
  cron: "Cron expression",
  once: "Once, at a set time",
};

interface ScheduleFormProps {
  schedule?: ScheduleDto | null;
  agents: AgentDto[];
  projects: ProjectDto[];
  onSaved: (schedule: ScheduleDto) => void;
  onCancel: () => void;
}

/** Create or edit a schedule (spec §26). */
export function ScheduleForm({ schedule = null, agents, projects, onSaved, onCancel }: ScheduleFormProps) {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [name, setName] = useState(schedule?.name ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [agentId, setAgentId] = useState(schedule?.agent?.id ?? AUTO_AGENT);
  const [projectId, setProjectId] = useState(schedule?.projectId ?? NO_PROJECT);
  const [timezone, setTimezone] = useState(schedule?.timezone ?? browserZone);
  const [trigger, setTrigger] = useState<ScheduleTrigger>(schedule?.trigger ?? "daily");
  const [timeOfDay, setTimeOfDay] = useState(schedule?.timeOfDay ?? "08:00");
  const [weekday, setWeekday] = useState(String(schedule?.weekday ?? 1));
  const [dayOfMonth, setDayOfMonth] = useState(String(schedule?.dayOfMonth ?? 1));
  const [intervalMinutes, setIntervalMinutes] = useState(String(schedule?.intervalMinutes ?? 60));
  const [cron, setCron] = useState(schedule?.cron ?? "0 8 * * 1-5");
  const [runAt, setRunAt] = useState(schedule?.runAt ? schedule.runAt.slice(0, 16) : "");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body = {
        name,
        prompt,
        agentId: agentId === AUTO_AGENT ? null : agentId,
        projectId: projectId === NO_PROJECT ? null : projectId,
        timezone,
        enabled,
        trigger,
        ...(trigger === "cron" ? { cron } : {}),
        ...(trigger === "interval" ? { intervalMinutes: Number(intervalMinutes) } : {}),
        ...(["daily", "weekly", "monthly"].includes(trigger) ? { timeOfDay } : {}),
        ...(trigger === "weekly" ? { weekday: Number(weekday) } : {}),
        ...(trigger === "monthly" ? { dayOfMonth: Number(dayOfMonth) } : {}),
        ...(trigger === "once" ? { runAt: new Date(runAt).toISOString() } : {}),
      };
      const saved = schedule
        ? await apiFetch<ScheduleDto>(`/api/schedules/${schedule.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await apiFetch<ScheduleDto>("/api/schedules", { method: "POST", body: JSON.stringify(body) });
      toast.success(schedule ? "Schedule saved" : `${saved.name} scheduled`);
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-xl border bg-card p-4">
      <div className="grid gap-1.5">
        <Label htmlFor="schedule-name">Name</Label>
        <Input id="schedule-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="Morning AI news" />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="schedule-prompt">Task</Label>
        <Textarea
          id="schedule-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          required
          placeholder="Research the latest AI agent news and write a short summary."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="schedule-agent">Agent</Label>
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger id="schedule-agent" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO_AGENT}>Choose automatically</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="schedule-project">Project</Label>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger id="schedule-project" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PROJECT}>No project</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="schedule-trigger">Runs</Label>
          <Select value={trigger} onValueChange={(v) => setTrigger(v as ScheduleTrigger)}>
            <SelectTrigger id="schedule-trigger" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(TRIGGER_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {trigger !== "interval" && trigger !== "once" && (
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-timezone">Time zone</Label>
            <Input id="schedule-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} maxLength={64} required className="font-mono text-xs" />
          </div>
        )}

        {["daily", "weekly", "monthly"].includes(trigger) && (
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-time">Time of day</Label>
            <Input id="schedule-time" type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} required />
          </div>
        )}

        {trigger === "weekly" && (
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-weekday">Day</Label>
            <Select value={weekday} onValueChange={setWeekday}>
              <SelectTrigger id="schedule-weekday" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((day, index) => (
                  <SelectItem key={day} value={String(index)}>
                    {day}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {trigger === "monthly" && (
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-day">Day of the month</Label>
            <Input id="schedule-day" type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} required />
          </div>
        )}

        {trigger === "interval" && (
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-interval">Every (minutes)</Label>
            <Input id="schedule-interval" type="number" min={5} max={43200} value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)} required />
          </div>
        )}

        {trigger === "cron" && (
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-cron">Cron expression</Label>
            <Input id="schedule-cron" value={cron} onChange={(e) => setCron(e.target.value)} required className="font-mono text-xs" placeholder="0 8 * * 1-5" />
          </div>
        )}

        {trigger === "once" && (
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-runat">Date and time</Label>
            <Input id="schedule-runat" type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} required />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <span>
          <Label htmlFor="schedule-enabled" className="block text-sm">
            Enabled
          </Label>
          <span className="block text-xs text-muted-foreground">A disabled schedule keeps its settings but never runs.</span>
        </span>
        <Switch id="schedule-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2Icon className="animate-spin" />} {schedule ? "Save changes" : "Create schedule"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
