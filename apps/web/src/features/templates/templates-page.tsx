"use client";

import type { AgentDto, ProjectDto, TemplateDto } from "@aiw/shared";
import { BookmarkIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/format";
import { fetchAgents } from "../agents/use-agents";
import { useModels } from "../chat/use-models";
import { deleteTemplate, listTemplates } from "./api";
import { TemplateForm } from "./template-form";

/** Saved prompts: create, edit, delete, and start a task from one. */
export function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateDto[] | null>(null);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const { models } = useModels();

  useEffect(() => {
    let active = true;
    Promise.all([listTemplates(), fetchAgents(), apiFetch<{ projects: ProjectDto[] }>("/api/projects")])
      .then(([t, a, p]) => {
        if (!active) return;
        setTemplates(t);
        setAgents(a.filter((agent) => agent.enabled));
        setProjects(p.projects);
      })
      .catch((e: unknown) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, []);

  function saved(template: TemplateDto) {
    setTemplates((current) => [template, ...(current ?? []).filter((t) => t.id !== template.id)]);
    setCreating(false);
    setEditing(null);
  }

  async function remove(template: TemplateDto) {
    const previous = templates;
    setTemplates((current) => current?.filter((t) => t.id !== template.id) ?? null);
    try {
      await deleteTemplate(template.id);
    } catch (e) {
      setTemplates(previous);
      toast.error(errorMessage(e));
    }
  }

  const formProps = { agents, projects, models, onSaved: saved };

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Prompts you use again and again. Pick one from the bookmark in the composer, or start it from here. Blanks written as{" "}
              <span className="font-mono">{"{{name}}"}</span> are asked for each time.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setCreating((v) => !v);
              setEditing(null);
            }}
          >
            <PlusIcon /> New template
          </Button>
        </div>

        {creating && (
          <div className="mt-4">
            <TemplateForm {...formProps} onCancel={() => setCreating(false)} />
          </div>
        )}

        {error ? (
          <p role="alert" className="mt-6 text-sm text-destructive">
            {error}
          </p>
        ) : templates === null ? (
          <div className="mt-6 grid gap-3">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : templates.length === 0 && !creating ? (
          <div className="mt-6 rounded-xl border border-dashed px-6 py-10 text-center">
            <BookmarkIcon className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 font-medium">No templates yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              For example: “Review the open issues in {"{{repository}}"} and list the three most urgent.”
            </p>
          </div>
        ) : (
          <ul className="mt-6 grid gap-3">
            {templates.map((template) =>
              editing === template.id ? (
                <li key={template.id}>
                  <TemplateForm {...formProps} template={template} onCancel={() => setEditing(null)} />
                </li>
              ) : (
                <li key={template.id} className="rounded-xl border bg-card">
                  <div className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0 truncate font-medium">{template.name}</h2>
                      {template.agent && <Badge variant="secondary">{template.agent.name}</Badge>}
                      {template.project && <Badge variant="outline">{template.project.name}</Badge>}
                      {template.model && <Badge variant="outline" className="font-mono text-[0.7rem]">{template.model}</Badge>}
                    </div>
                    <p className="mt-1 line-clamp-3 text-sm whitespace-pre-wrap text-muted-foreground">{template.prompt}</p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {template.variables.length > 0 && (
                        <span>
                          Asks for: <span className="font-mono">{template.variables.join(", ")}</span>
                        </span>
                      )}
                      <span>{template.lastUsedAt ? `Used ${formatRelativeTime(template.lastUsedAt)}` : "Not used yet"}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 border-t px-4 py-2">
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/?template=${template.id}`}>
                        <PlayIcon /> Use
                      </Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(template.id);
                        setCreating(false);
                      }}
                    >
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" className="ml-auto" aria-label={`Delete ${template.name}`} onClick={() => void remove(template)}>
                      <Trash2Icon />
                    </Button>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
