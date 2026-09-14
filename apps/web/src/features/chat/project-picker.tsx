"use client";

import type { ProjectDto } from "@aiw/shared";
import { FolderKanbanIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch } from "@/lib/api-client";

export const NO_PROJECT = "__none__";

/**
 * Runs the task inside a project, so it uses that project's folder and memory
 * (spec §3 "Project selection"). Hidden until the user has a project.
 */
export function ProjectPicker({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);

  useEffect(() => {
    let active = true;
    apiFetch<{ projects: ProjectDto[] }>("/api/projects")
      .then((r) => active && setProjects(r.projects))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (projects.length === 0 && value === NO_PROJECT) return null;

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size="sm" aria-label="Project" className="max-w-44">
        <FolderKanbanIcon className="size-3.5 text-muted-foreground" />
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
  );
}
