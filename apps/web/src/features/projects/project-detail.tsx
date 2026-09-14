"use client";

import type { ConversationDto, MemoryDto, ProjectDto, TaskDto } from "@aiw/shared";
import { ArchiveIcon, ArchiveRestoreIcon, ArrowLeftIcon, FolderKanbanIcon, Loader2Icon, MessagesSquareIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/format";
import { FileBrowser } from "../files/file-browser";
import { TaskStatusBadge } from "../tasks/task-status";
import { MemoryList } from "./memory-list";

interface ProjectDetailProps {
  project: ProjectDto;
  conversations: ConversationDto[];
  tasks: TaskDto[];
  memories: MemoryDto[];
}

export function ProjectDetail({ project: initial, conversations, tasks, memories }: ProjectDetailProps) {
  const router = useRouter();
  const [project, setProject] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [saving, setSaving] = useState(false);

  async function patch(changes: Record<string, unknown>) {
    setSaving(true);
    try {
      setProject(await apiFetch<ProjectDto>(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify(changes) }));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" });
      toast.success(`${project.name} deleted`);
      router.push("/projects");
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <div>
          <Link href="/projects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-4" /> Projects
          </Link>
          <div className="mt-3 flex flex-wrap items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/50">
              <FolderKanbanIcon className="size-5 text-muted-foreground" />
            </span>
            <div className="min-w-0 flex-1">
              {editing ? (
                <div className="grid gap-2">
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} placeholder="Description" />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={saving}
                      onClick={() => void patch({ name, description: description.trim() || null }).then(() => setEditing(false))}
                    >
                      {saving && <Loader2Icon className="animate-spin" />} Save
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <h1 className="text-2xl font-semibold tracking-tight break-words">{project.name}</h1>
                  {project.archived && (
                    <Badge variant="outline" className="mt-1 text-[0.65rem]">
                      Archived
                    </Badge>
                  )}
                  {project.description && <p className="mt-2 text-sm text-muted-foreground">{project.description}</p>}
                </>
              )}
            </div>
            {!editing && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button size="sm" variant="outline" disabled={saving} onClick={() => void patch({ archived: !project.archived })}>
                  {project.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />} {project.archived ? "Unarchive" : "Archive"}
                </Button>
              </div>
            )}
          </div>
        </div>

        <Tabs defaultValue="overview" className="gap-4">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="memory">
              Memory <span className="ml-1 text-xs text-muted-foreground tabular-nums">{project.memoryCount}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="grid grid-cols-1 gap-6">
            <section className="rounded-xl border bg-card">
              <header className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-semibold">Conversations</h2>
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/?projectId=${project.id}`}>
                    <MessagesSquareIcon /> New task in this project
                  </Link>
                </Button>
              </header>
              {conversations.length === 0 ? (
                <p className="px-4 py-4 text-sm text-muted-foreground">No conversations yet.</p>
              ) : (
                <ul className="divide-y">
                  {conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <Link href={`/c/${conversation.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                        <span className="min-w-0 flex-1 truncate text-sm">{conversation.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(conversation.lastMessageAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border bg-card">
              <header className="border-b px-4 py-3">
                <h2 className="text-sm font-semibold">Tasks</h2>
              </header>
              {tasks.length === 0 ? (
                <p className="px-4 py-4 text-sm text-muted-foreground">No tasks yet.</p>
              ) : (
                <ul className="divide-y">
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <Link href={`/tasks/${task.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                        <TaskStatusBadge status={task.status} />
                        <span className="min-w-0 flex-1 truncate text-sm">{task.prompt}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(task.createdAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="flex flex-wrap items-center gap-2">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="destructive" size="sm">
                    <Trash2Icon /> Delete project
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Its conversations and tasks are kept but leave the project, and its memory is deleted. Files in the project folder stay on disk.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => void remove()}>
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </TabsContent>

          <TabsContent value="files">
            <section className="rounded-xl border bg-card p-4">
              <FileBrowser projectId={project.id} />
            </section>
          </TabsContent>

          <TabsContent value="memory">
            <section className="grid gap-3 rounded-xl border bg-card p-4">
              <p className="text-sm text-muted-foreground">
                Short facts every agent working in this project is told, and can add to with its memory tools.
              </p>
              <MemoryList memories={memories} target={{ scope: "project", projectId: project.id }} emptyText="Nothing remembered for this project yet." />
            </section>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
