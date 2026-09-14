import type { CreateTaskInput, CreateTaskResponse, TaskDto, TaskEvent, TaskWithStepsDto } from "@aiw/shared";
import { apiFetch } from "@/lib/api-client";

export type TaskAction = "stop" | "retry" | "continue" | "pause" | "resume";

export type TaskFilter = "all" | "active" | "completed" | "failed" | "cancelled";

export async function fetchTasks(status: TaskFilter): Promise<TaskDto[]> {
  const { tasks } = await apiFetch<{ tasks: TaskDto[] }>(`/api/tasks?status=${status}&limit=100`);
  return tasks;
}

export function fetchTask(id: string): Promise<TaskWithStepsDto> {
  return apiFetch(`/api/tasks/${id}`);
}

export function createTask(input: CreateTaskInput): Promise<CreateTaskResponse> {
  return apiFetch("/api/tasks", { method: "POST", body: JSON.stringify(input) });
}

export function controlTask(id: string, action: TaskAction): Promise<TaskWithStepsDto> {
  return apiFetch(`/api/tasks/${id}/${action}`, { method: "POST" });
}

export async function fetchTaskEvents(id: string): Promise<TaskEvent[]> {
  const { events } = await apiFetch<{ events: TaskEvent[] }>(`/api/tasks/${id}/events`);
  return events;
}
