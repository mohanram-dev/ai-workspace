"use client";

import type { ProjectDto } from "@aiw/shared";
import { ArchiveIcon, FolderKanbanIcon, Loader2Icon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/** Projects group conversations, tasks, files and memory around one goal (spec §23). */
export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    // Show the skeleton again while the other list loads.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProjects(null);
    apiFetch<{ projects: ProjectDto[] }>(`/api/projects${showArchived ? "?archived=true" : ""}`)
      .then((r) => active && setProjects(r.projects))
      .catch((e: unknown) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, [showArchived]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const project = await apiFetch<ProjectDto>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name, description: description.trim() || null }),
      });
      setProjects((current) => [project, ...(current ?? [])]);
      setName("");
      setDescription("");
      setCreating(false);
      toast.success(`${project.name} created`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              A project keeps its conversations, tasks, files and memory together. Agents working in a project share its folder and what it remembers.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowArchived((v) => !v)}>
              <ArchiveIcon /> {showArchived ? "Hide archived" : "Show archived"}
            </Button>
            <Button size="sm" onClick={() => setCreating((v) => !v)}>
              <PlusIcon /> New project
            </Button>
          </div>
        </div>

        {creating && (
          <form method="post" onSubmit={create} className="mt-4 grid gap-3 rounded-xl border bg-card p-4">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" maxLength={80} required autoFocus />
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project for? (optional)" rows={2} maxLength={1000} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={saving}>
                {saving && <Loader2Icon className="animate-spin" />} Create
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {error ? (
          <p className="mt-6 text-sm text-destructive">{error}</p>
        ) : projects === null ? (
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-32 rounded-xl" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed px-6 py-10 text-center">
            <FolderKanbanIcon className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 font-medium">{showArchived ? "No archived projects" : "No projects yet"}</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Create one to group related work. You can pick a project when starting a task.
            </p>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {projects.map((project) => (
              <div key={project.id} className={cn("relative rounded-xl border bg-card p-4 transition-colors hover:border-ring/40", project.archived && "opacity-70")}>
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                    <FolderKanbanIcon className="size-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link href={`/projects/${project.id}`} className="font-medium break-words after:absolute after:inset-0 hover:underline">
                      {project.name}
                    </Link>
                    {project.archived && (
                      <Badge variant="outline" className="ml-2 text-[0.65rem]">
                        Archived
                      </Badge>
                    )}
                    {project.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{project.description}</p>}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{project.conversationCount} conversations</span>
                  <span>{project.taskCount} tasks</span>
                  <span>{project.memoryCount} memories</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
