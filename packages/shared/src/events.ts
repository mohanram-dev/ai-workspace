import { z } from "zod";
import type { TaskError, TaskRouting, TaskStatus } from "./tasks";

/**
 * Execution events persisted for every task (spec §5, §36). Browser session,
 * computer use and approval events are added by the phases that
 * implement those capabilities.
 */
export const TASK_EVENT_TYPES = [
  "TASK_CREATED",
  "AGENT_SELECTED",
  "AGENT_STARTED",
  "THINKING_STATUS",
  "PLAN_CREATED",
  "STEP_STARTED",
  "STEP_COMPLETED",
  "STEP_FAILED",
  "TASK_PROGRESS",
  "MODEL_CALL_FINISHED",
  "TOOL_CALL_STARTED",
  "TOOL_CALL_FINISHED",
  "FILE_READ",
  "FILE_CREATED",
  "FILE_UPDATED",
  "TERMINAL_COMMAND_STARTED",
  "TERMINAL_COMMAND_FINISHED",
  "PAGE_READ",
  "MCP_TOOL_STARTED",
  "MCP_TOOL_FINISHED",
  "BROWSER_OPENED",
  "PAGE_NAVIGATED",
  "BROWSER_ACTION",
  "BROWSER_SCREENSHOT",
  "BROWSER_CLOSED",
  "COMPUTER_STARTED",
  "COMPUTER_ACTION",
  "COMPUTER_SCREENSHOT",
  "COMPUTER_STOPPED",
  "APPROVAL_REQUIRED",
  "APPROVAL_GRANTED",
  "APPROVAL_REJECTED",
  "AUTONOMOUS_ACTION",
  "AGENT_MESSAGE",
  "TASK_DELEGATED",
  "SUBTASK_FINISHED",
  "TASK_PAUSE_REQUESTED",
  "TASK_PAUSED",
  "TASK_RESUMED",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "TASK_CANCELLED",
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export type TaskEventStatus = "info" | "running" | "success" | "warning" | "error";

export interface TaskEventDataMap {
  TASK_CREATED: { prompt: string; mode: "auto" | "manual"; retryOfTaskId: string | null };
  AGENT_SELECTED: { agentName: string; agentSlug: string; routing: TaskRouting };
  AGENT_STARTED: { agentName: string; provider: string; model: string; attempt: number };
  THINKING_STATUS: { text: string };
  PLAN_CREATED: { steps: { id: string; index: number; title: string }[]; planned: boolean };
  STEP_STARTED: { index: number; total: number; title: string; kind: "only" | "intermediate" | "synthesis" };
  STEP_COMPLETED: { index: number; title: string; inputTokens: number; outputTokens: number; outputLength: number };
  STEP_FAILED: { index: number; title: string; status: "failed" | "cancelled"; error: string | null };
  TASK_PROGRESS: { completed: number; total: number; percent: number };
  MODEL_CALL_FINISHED: {
    purpose: "routing" | "planning" | "step" | "tool";
    provider: string;
    model: string;
    status: "completed" | "failed" | "cancelled";
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number | null;
    attempt: number;
    errorCode: string | null;
  };
  TOOL_CALL_STARTED: { toolCallId: string; toolName: string; category: string; permission: string; input: unknown };
  TOOL_CALL_FINISHED: {
    toolCallId: string;
    toolName: string;
    status: "completed" | "failed" | "denied" | "cancelled";
    summary: string | null;
    error: string | null;
    errorCode: string | null;
  };
  FILE_READ: { toolCallId: string; path: string; bytes: number };
  FILE_CREATED: { toolCallId: string; path: string; bytes: number };
  FILE_UPDATED: { toolCallId: string; path: string; bytes: number };
  TERMINAL_COMMAND_STARTED: { toolCallId: string; command: string; cwd: string };
  TERMINAL_COMMAND_FINISHED: { toolCallId: string; command: string; cwd: string; exitCode: number | null; timedOut: boolean };
  PAGE_READ: { toolCallId: string; url: string; title: string | null; status: number; bytes: number };
  MCP_TOOL_STARTED: { toolCallId: string; serverId: string; serverName: string; tool: string };
  MCP_TOOL_FINISHED: { toolCallId: string; serverId: string; serverName: string; tool: string; isError: boolean };
  BROWSER_OPENED: { toolCallId: string };
  PAGE_NAVIGATED: { toolCallId: string; url: string; title: string | null };
  BROWSER_ACTION: { toolCallId: string; action: "click" | "type" | "select" | "press" | "scroll" | "back"; target: string; url: string };
  /** The image itself is served by GET /api/tasks/:id/screenshots/:screenshotId. */
  BROWSER_SCREENSHOT: { toolCallId: string; screenshotId: string; url: string; title: string | null; width: number; height: number; reason: string };
  BROWSER_CLOSED: { toolCallId: string };
  COMPUTER_STARTED: { toolCallId: string; platform: string; screenWidth: number; screenHeight: number };
  COMPUTER_ACTION: { toolCallId: string; action: "move" | "click" | "double_click" | "right_click" | "drag" | "scroll" | "type" | "key" | "wait"; target: string };
  COMPUTER_SCREENSHOT: { toolCallId: string; screenshotId: string; width: number; height: number; reason: string };
  COMPUTER_STOPPED: { toolCallId: string };
  APPROVAL_REQUIRED: { approvalId: string; toolCallId: string; toolName: string; permission: string; action: string; input: unknown };
  APPROVAL_GRANTED: { approvalId: string; toolCallId: string; toolName: string; scope: "once" | "task"; decidedBy: string | null };
  APPROVAL_REJECTED: { approvalId: string; toolCallId: string; toolName: string; reason: string | null; expired: boolean };
  /** A destructive action the agent ran unattended because the user trusted that tool (spec §27). */
  AUTONOMOUS_ACTION: { toolCallId: string; toolName: string; permission: string; action: string };
  /** The agent's answer in its own words, as a timeline entry (spec §5). */
  AGENT_MESSAGE: { text: string; truncated: boolean };
  TASK_DELEGATED: { toolCallId: string; taskId: string; agentId: string; agentName: string; instruction: string };
  SUBTASK_FINISHED: { toolCallId: string; taskId: string; agentName: string; status: string; inputTokens: number; outputTokens: number };
  TASK_PAUSE_REQUESTED: Record<string, never>;
  TASK_PAUSED: { completedSteps: number; totalSteps: number };
  TASK_RESUMED: { reason: "resume" | "continue"; attempt: number };
  TASK_COMPLETED: { inputTokens: number; outputTokens: number; estimatedCostUsd: number | null; resultLength: number };
  TASK_FAILED: { error: TaskError };
  TASK_CANCELLED: Record<string, never>;
}

interface TaskEventBase {
  /** Monotonic id; also the SSE event id used for resuming a stream. */
  id: number;
  taskId: string;
  timestamp: string;
  agent: { id: string; name: string } | null;
  stepId: string | null;
  /** Human-readable description shown in the activity timeline. */
  description: string;
  status: TaskEventStatus;
  /** Set on tool events. */
  toolName: string | null;
  durationMs: number | null;
}

/** Strongly typed union: `event.type` narrows `event.data`. */
export type TaskEvent = {
  [K in TaskEventType]: TaskEventBase & { type: K; data: TaskEventDataMap[K] };
}[TaskEventType];

export type TaskEventOf<K extends TaskEventType> = Extract<TaskEvent, { type: K }>;

/** Ephemeral, not persisted: streamed model output for the running step. */
export interface StepOutputDelta {
  taskId: string;
  stepId: string;
  text: string;
  /** Discard earlier output for this step (the model call is being retried). */
  reset?: boolean;
}

/** Runtime validation of the event envelope received over SSE. */
export const taskEventEnvelopeSchema = z.object({
  id: z.number().int().positive(),
  taskId: z.string(),
  type: z.enum(TASK_EVENT_TYPES),
  timestamp: z.string(),
  agent: z.object({ id: z.string(), name: z.string() }).nullable(),
  stepId: z.string().nullable(),
  description: z.string(),
  status: z.enum(["info", "running", "success", "warning", "error"]),
  toolName: z.string().nullable(),
  durationMs: z.number().nullable(),
  data: z.record(z.string(), z.unknown()),
});

export const terminalOutputDeltaSchema = z.object({
  taskId: z.string(),
  toolCallId: z.string(),
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
});

/** Live preview notification (browser or desktop): the frame image is fetched from GET /api/tasks/:id/{browser|computer}/frame. */
export const browserFrameDeltaSchema = z.object({
  taskId: z.string(),
  seq: z.number().int(),
  url: z.string(),
  title: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  capturedAt: z.string(),
});
export type BrowserFrameDelta = z.infer<typeof browserFrameDeltaSchema>;

/** Live desktop preview notification; the frame image is fetched from GET /api/tasks/:id/computer/frame. */
export const computerFrameDeltaSchema = z.object({
  taskId: z.string(),
  seq: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  capturedAt: z.string(),
});
export type ComputerFrameDelta = z.infer<typeof computerFrameDeltaSchema>;

export const stepOutputDeltaSchema = z.object({
  taskId: z.string(),
  stepId: z.string(),
  text: z.string(),
  reset: z.boolean().optional(),
});

/** Events after which a task stream can close (nothing more will happen until a user action). */
export const STREAM_END_EVENT_TYPES: readonly TaskEventType[] = ["TASK_COMPLETED", "TASK_FAILED", "TASK_CANCELLED", "TASK_PAUSED"];

export const STREAM_END_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled", "paused"];
