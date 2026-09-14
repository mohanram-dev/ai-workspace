import { z } from "zod";
import { MAX_MESSAGE_LENGTH, type MessageDto } from "./chat";
import type { ScreenshotDto, ToolCallDto } from "./tools";

/** Task lifecycle states (spec §38). WAITING_* and PAUSED are reserved for later phases. */
export const TASK_STATUSES = [
  "queued",
  "planning",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVE_TASK_STATUSES = [
  "queued",
  "planning",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "paused",
] as const satisfies readonly TaskStatus[];

export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled"] as const satisfies readonly TaskStatus[];

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return (ACTIVE_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

export const TASK_STEP_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type TaskStepStatus = (typeof TASK_STEP_STATUSES)[number];

export const createTaskSchema = z.object({
  prompt: z.string().trim().min(1, "Task cannot be empty").max(MAX_MESSAGE_LENGTH),
  /** Omit for automatic routing. */
  agentId: z.uuid().optional(),
  /** Attach to an existing conversation; omitted = new conversation. */
  conversationId: z.uuid().optional(),
  /** Override the agent's model for this task. */
  model: z.string().min(1).max(200).optional(),
  /** Run inside a project: its files and memory are used. */
  projectId: z.uuid().nullish(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const listTasksQuerySchema = z.object({
  status: z.enum(["all", "active", "completed", "failed", "cancelled"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface TaskRouting {
  mode: "auto" | "manual";
  method: "llm" | "fallback" | "single" | "manual";
  reason: string;
  confidence: number | null;
}

/** Human-readable failure report (spec §20, §40). */
export interface TaskError {
  code: string;
  title: string;
  message: string;
  stepIndex: number | null;
  stepTitle: string | null;
  retryable: boolean;
  suggestedAction: string;
  /** Safe technical detail for advanced users (never secrets or stack traces). */
  detail: string | null;
}

export interface TaskStepDto {
  id: string;
  index: number;
  title: string;
  instruction: string;
  status: TaskStepStatus;
  output: string | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface TaskDto {
  id: string;
  prompt: string;
  status: TaskStatus;
  agent: { id: string; name: string; slug: string } | null;
  routing: TaskRouting | null;
  conversationId: string | null;
  projectId: string | null;
  projectName: string | null;
  /** Set when another agent delegated this task. */
  parentTaskId: string | null;
  /** 0 for a task you started; each delegation adds one. */
  depth: number;
  provider: string | null;
  model: string | null;
  modelOverride: string | null;
  result: string | null;
  error: TaskError | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  attempt: number;
  retryOfTaskId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  progress: { completed: number; total: number };
  /** True while a pause was requested and the current step is finishing. */
  pauseRequested: boolean;
  /** Id of the latest persisted event; streams resume after it. */
  lastEventId: number;
}

export interface TaskWithStepsDto extends TaskDto {
  steps: TaskStepDto[];
  toolCalls: ToolCallDto[];
  screenshots: ScreenshotDto[];
  /** Tasks this one delegated to other agents. */
  subTasks: SubTaskDto[];
}

export interface SubTaskDto {
  id: string;
  prompt: string;
  status: TaskStatus;
  agent: { id: string; name: string; slug: string } | null;
  result: string | null;
  error: TaskError | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  durationMs: number | null;
  createdAt: string;
}

export interface CreateTaskResponse {
  task: TaskDto;
  conversationId: string;
  conversationTitle: string;
  userMessage: MessageDto;
  assistantMessage: MessageDto;
}
