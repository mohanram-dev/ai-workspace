"use client";

import type { AgentDto, ModelDto, ProjectDto, WebhookDto, WebhookWithSecretDto } from "@aiw/shared";
import { Loader2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, errorMessage } from "@/lib/api-client";

const AUTO = "__auto__";

interface WebhookFormProps {
  webhook?: WebhookDto | null;
  agents: AgentDto[];
  projects: ProjectDto[];
  models: ModelDto[];
  /** A new webhook comes back with its secret; an edited one without. */
  onSaved: (webhook: WebhookDto | WebhookWithSecretDto) => void;
  onCancel: () => void;
}

export function WebhookForm({ webhook = null, agents, projects, models, onSaved, onCancel }: WebhookFormProps) {
  const [name, setName] = useState(webhook?.name ?? "");
  const [prompt, setPrompt] = useState(webhook?.prompt ?? "");
  const [agentId, setAgentId] = useState(webhook?.agent?.id ?? AUTO);
  const [projectId, setProjectId] = useState(webhook?.project?.id ?? AUTO);
  const [model, setModel] = useState(webhook?.model ?? AUTO);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const body = JSON.stringify({
      name,
      prompt,
      agentId: agentId === AUTO ? null : agentId,
      projectId: projectId === AUTO ? null : projectId,
      model: model === AUTO ? null : model,
    });
    try {
      onSaved(
        webhook
          ? await apiFetch<WebhookDto>(`/api/webhooks/${webhook.id}`, { method: "PATCH", body })
          : await apiFetch<WebhookWithSecretDto>("/api/webhooks", { method: "POST", body }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form method="post" onSubmit={(e) => void submit(e)} className="grid gap-4 rounded-xl border bg-card p-4">
      <div className="grid gap-1.5">
        <Label htmlFor="webhook-name">Name</Label>
        <Input id="webhook-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="New GitHub issue" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="webhook-prompt">What the agent should do with each delivery</Label>
        <Textarea
          id="webhook-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          required
          placeholder="A GitHub {{event}} arrived. Summarise it in three lines and say whether it needs attention today."
        />
        <p className="text-xs text-muted-foreground">
          The body that was sent is attached automatically, marked as data the agent must not take orders from.{" "}
          <span className="font-mono">{"{{event}}"}</span> becomes the sender&apos;s event name (GitHub&apos;s <span className="font-mono">X-GitHub-Event</span>).
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="webhook-agent">Agent</Label>
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger id="webhook-agent" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>Choose automatically</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="webhook-project">Project</Label>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger id="webhook-project" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>No project</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="webhook-model">Model</Label>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger id="webhook-model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>Agent&apos;s model</SelectItem>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !name.trim() || !prompt.trim()}>
          {saving && <Loader2Icon className="animate-spin" />} {webhook ? "Save" : "Create webhook"}
        </Button>
      </div>
    </form>
  );
}
