"use client";

import type { ProjectDto } from "@aiw/shared";
import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch } from "@/lib/api-client";
import { FileBrowser } from "./file-browser";

const PERSONAL = "__personal__";

/** The workspace file browser: personal files, or one project's files. */
export function FilesPage() {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [selected, setSelected] = useState(PERSONAL);

  useEffect(() => {
    let active = true;
    apiFetch<{ projects: ProjectDto[] }>("/api/projects")
      .then((r) => active && setProjects(r.projects))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Files</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              The folders agents read and write with their file tools. Each project has its own; everything else lives in your personal workspace.
            </p>
          </div>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="w-56" aria-label="Workspace">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PERSONAL}>Personal workspace</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="mt-6 rounded-xl border bg-card p-4">
          <FileBrowser key={selected} projectId={selected === PERSONAL ? null : selected} />
        </div>
      </div>
    </div>
  );
}
