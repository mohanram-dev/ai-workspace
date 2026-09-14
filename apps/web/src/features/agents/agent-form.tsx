"use client";

import { AGENT_LIMITS, type AgentConfig, type AgentDto, type ModelDto, type ToolInfoDto } from "@aiw/shared";
import { ArrowLeftIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { AgentIcon } from "./agent-icon";
import { AgentToolsSection } from "./agent-tools-section";
import { AutonomousSection } from "./autonomous-section";

const PROVIDER_DEFAULT = "__provider_default__";

export const NEW_AGENT_DEFAULTS: AgentConfig = {
  name: "",
  description: "",
  instructions: "",
  provider: "gemini",
  model: null,
  temperature: 0.5,
  maxOutputTokens: 8192,
  planningMode: "auto",
  maxSteps: 5,
  maxExecutionSeconds: 300,
  dailyBudgetUsd: null,
  useConversationHistory: true,
  maxHistoryMessages: 20,
  enabled: true,
  routable: true,
  tools: [],
  permissions: [],
  maxToolCalls: 20,
  autonomousMode: false,
  trustedTools: [],
};

interface AgentFormProps {
  agent: AgentDto | null;
  models: ModelDto[];
  providers: { id: string; name: string; configured: boolean; defaultModel: string }[];
  tools: ToolInfoDto[];
}

export function AgentForm({ agent, models, providers, tools }: AgentFormProps) {
  const router = useRouter();
  const [config, setConfig] = useState<AgentConfig>(agent ?? NEW_AGENT_DEFAULTS);
  const [budgetText, setBudgetText] = useState(agent?.dailyBudgetUsd?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const provider = providers.find((p) => p.id === config.provider);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const budget = budgetText.trim() === "" ? null : Number(budgetText);
    if (budget !== null && (!Number.isFinite(budget) || budget < 0)) {
      setError("Daily budget must be a positive number or empty.");
      return;
    }
    setSaving(true);
    try {
      const body = JSON.stringify({ ...config, dailyBudgetUsd: budget });
      const saved = agent
        ? await apiFetch<AgentDto>(`/api/agents/${agent.id}`, { method: "PATCH", body })
        : await apiFetch<AgentDto>("/api/agents", { method: "POST", body });
      toast.success(agent ? "Agent saved" : "Agent created");
      router.push(agent ? "/agents" : `/agents/${saved.id}`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!agent) return;
    try {
      await apiFetch(`/api/agents/${agent.id}`, { method: "DELETE" });
      toast.success("Agent deleted");
      router.push("/agents");
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <form method="post" onSubmit={onSubmit} className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <div>
          <Link href="/agents" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-4" /> Agents
          </Link>
          <div className="mt-3 flex items-center gap-3">
            <AgentIcon slug={agent?.slug ?? "custom"} className="size-10 rounded-xl" />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{agent ? agent.name : "New agent"}</h1>
              {agent?.builtin && <Badge variant="secondary" className="mt-1">Built-in</Badge>}
            </div>
          </div>
        </div>

        <Section title="Identity" description="The description is what the router reads when choosing an agent.">
          <Field label="Name" htmlFor="name">
            <Input id="name" value={config.name} onChange={(e) => set("name", e.target.value)} required maxLength={60} />
          </Field>
          <Field label="Description" htmlFor="description">
            <Textarea
              id="description"
              value={config.description}
              onChange={(e) => set("description", e.target.value)}
              required
              maxLength={500}
              rows={2}
            />
          </Field>
          <Field label="System instructions" htmlFor="instructions" hint="How the agent should think and respond.">
            <Textarea
              id="instructions"
              value={config.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              maxLength={20_000}
              rows={6}
              className="font-mono text-[0.8125rem]"
            />
          </Field>
        </Section>

        <Section title="Model">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" htmlFor="provider">
              <Select value={config.provider} onValueChange={(v) => setConfig((c) => ({ ...c, provider: v, model: null }))}>
                <SelectTrigger id="provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                      {!p.configured && " (not configured)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Model" htmlFor="model">
              <Select
                value={config.model ?? PROVIDER_DEFAULT}
                onValueChange={(v) => set("model", v === PROVIDER_DEFAULT ? null : v)}
              >
                <SelectTrigger id="model" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PROVIDER_DEFAULT}>Provider default ({provider?.defaultModel ?? "—"})</SelectItem>
                  {models
                    .filter((m) => m.provider === config.provider)
                    .map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  {config.model && !models.some((m) => m.id === config.model) && (
                    <SelectItem value={config.model}>{config.model} (unavailable)</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </Field>
            <NumberField
              id="temperature"
              label="Temperature"
              value={config.temperature}
              onChange={(v) => set("temperature", v)}
              min={AGENT_LIMITS.temperature.min}
              max={AGENT_LIMITS.temperature.max}
              step={0.1}
              hint="Lower is more focused, higher more creative."
            />
            <NumberField
              id="maxOutputTokens"
              label="Max output tokens per call"
              value={config.maxOutputTokens}
              onChange={(v) => set("maxOutputTokens", v)}
              min={AGENT_LIMITS.maxOutputTokens.min}
              max={AGENT_LIMITS.maxOutputTokens.max}
              step={256}
            />
          </div>
        </Section>

        <Section title="Execution limits">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Planning" htmlFor="planningMode">
              <Select value={config.planningMode} onValueChange={(v) => set("planningMode", v as AgentConfig["planningMode"])}>
                <SelectTrigger id="planningMode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Plan when the task needs it</SelectItem>
                  <SelectItem value="always">Always create a plan</SelectItem>
                  <SelectItem value="never">Never plan (single step)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <NumberField
              id="maxSteps"
              label="Maximum plan steps"
              value={config.maxSteps}
              onChange={(v) => set("maxSteps", v)}
              min={AGENT_LIMITS.maxSteps.min}
              max={AGENT_LIMITS.maxSteps.max}
            />
            <NumberField
              id="maxExecutionSeconds"
              label="Maximum execution time (seconds)"
              value={config.maxExecutionSeconds}
              onChange={(v) => set("maxExecutionSeconds", v)}
              min={AGENT_LIMITS.maxExecutionSeconds.min}
              max={AGENT_LIMITS.maxExecutionSeconds.max}
            />
            <Field label="Daily budget (USD)" htmlFor="dailyBudgetUsd" hint="Empty for no limit. Uses estimated model cost.">
              <Input
                id="dailyBudgetUsd"
                inputMode="decimal"
                placeholder="No limit"
                value={budgetText}
                onChange={(e) => setBudgetText(e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section title="Context">
          <ToggleRow
            id="useConversationHistory"
            label="Use conversation history"
            description="Include earlier messages from the conversation as context."
            checked={config.useConversationHistory}
            onChange={(v) => set("useConversationHistory", v)}
          />
          <NumberField
            id="maxHistoryMessages"
            label="Maximum history messages"
            value={config.maxHistoryMessages}
            onChange={(v) => set("maxHistoryMessages", v)}
            min={AGENT_LIMITS.maxHistoryMessages.min}
            max={AGENT_LIMITS.maxHistoryMessages.max}
            disabled={!config.useConversationHistory}
          />
        </Section>

        <Section title="Availability">
          <ToggleRow
            id="enabled"
            label="Enabled"
            description="Disabled agents cannot run tasks."
            checked={config.enabled}
            onChange={(v) => set("enabled", v)}
          />
          <ToggleRow
            id="routable"
            label="Allow automatic routing"
            description="When off, the agent only runs when selected explicitly."
            checked={config.routable}
            onChange={(v) => set("routable", v)}
          />
        </Section>

        <Section title="Tools and permissions" description="Agents can only call tools assigned here, within the permissions granted.">
          <AgentToolsSection
            available={tools}
            tools={config.tools}
            permissions={config.permissions}
            maxToolCalls={config.maxToolCalls}
            onToolsChange={(value) => set("tools", value)}
            onPermissionsChange={(value) => set("permissions", value)}
            onMaxToolCallsChange={(value) => set("maxToolCalls", value)}
          />
        </Section>

        <Section
          title="Autonomous mode"
          description="Let this agent run destructive actions you have trusted without waiting for approval (spec §27)."
        >
          <AutonomousSection
            available={tools}
            assigned={config.tools}
            autonomousMode={config.autonomousMode}
            trustedTools={config.trustedTools}
            onAutonomousModeChange={(value) => set("autonomousMode", value)}
            onTrustedToolsChange={(value) => set("trustedTools", value)}
          />
        </Section>


        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving && <Loader2Icon className="animate-spin" />}
            {agent ? "Save changes" : "Create agent"}
          </Button>
          <Button type="button" variant="outline" asChild>
            <Link href="/agents">Cancel</Link>
          </Button>
          {agent && !agent.builtin && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="destructive" className="ml-auto">
                  <Trash2Icon /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The agent is removed permanently. Past tasks keep their history but lose the link to this agent.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => void onDelete()}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {agent?.builtin && (
            <p className="ml-auto text-xs text-muted-foreground">Built-in agents can be disabled but not deleted.</p>
          )}
        </div>
      </form>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="border-b px-4 py-3 sm:px-5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </header>
      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  hint,
  disabled,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} htmlFor={id} {...(hint ? { hint } : {})}>
      <Input
        id={id}
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        required
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
    </Field>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
