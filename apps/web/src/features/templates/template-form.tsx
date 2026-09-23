"use client";

import { templateVariables, type AgentDto, type ModelDto, type ProjectDto, type TemplateDto } from "@aiw/shared";
import { Loader2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api-client";
import { createTemplate, updateTemplate } from "./api";

const KEEP = "__keep__";

interface TemplateFormProps {
  template?: TemplateDto | null;
  agents: AgentDto[];
  projects: ProjectDto[];
  models: ModelDto[];
  onSaved: (template: TemplateDto) => void;
  onCancel: () => void;
}

/** Create or edit a saved prompt. */
export function TemplateForm({ template = null, agents, projects, models, onSaved, onCancel }: TemplateFormProps) {
  const [name, setName] = useState(template?.name ?? "");
  const [prompt, setPrompt] = useState(template?.prompt ?? "");
  const [agentId, setAgentId] = useState(template?.agent?.id ?? KEEP);
  const [projectId, setProjectId] = useState(template?.project?.id ?? KEEP);
  const [model, setModel] = useState(template?.model ?? KEEP);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const variables = templateVariables(prompt);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const input = {
      name,
      prompt,
      agentId: agentId === KEEP ? null : agentId,
      projectId: projectId === KEEP ? null : projectId,
      model: model === KEEP ? null : model,
    };
    try {
      onSaved(template ? await updateTemplate(template.id, input) : await createTemplate(input));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form method="post" onSubmit={(e) => void submit(e)} className="grid gap-4 rounded-xl border bg-card p-4">
      <div className="grid gap-1.5">
        <Label htmlFor="template-name">Name</Label>
        <Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="template-prompt">Prompt</Label>
        <Textarea
          id="template-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          required
          placeholder="Review the open issues in {{repository}} and list the three most urgent."
        />
        <p className="text-xs text-muted-foreground">
          {variables.length > 0 ? (
            <>
              Asks for: <span className="font-mono">{variables.join(", ")}</span>
            </>
          ) : (
            <>
              Write <span className="font-mono">{"{{name}}"}</span> for a blank you fill in each time.
            </>
          )}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="template-agent">Agent</Label>
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger id="template-agent" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>Keep current</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="template-project">Project</Label>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger id="template-project" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>Keep current</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="template-model">Model</Label>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger id="template-model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>Keep current</SelectItem>
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
          {saving && <Loader2Icon className="animate-spin" />} {template ? "Save" : "Create template"}
        </Button>
      </div>
    </form>
  );
}
