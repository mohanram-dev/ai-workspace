import type { z } from "zod";
import type { Workspace } from "./workspace";

/** Permission levels (spec §16). READ is always allowed for an assigned tool; DESTRUCTIVE needs human approval. */
export const PERMISSION_LEVELS = ["READ", "WRITE", "EXECUTE", "NETWORK", "DESTRUCTIVE"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export type ToolCategory = "files" | "terminal" | "git" | "web" | "browser" | "computer" | "memory" | "agent" | "docker" | "ssh" | "github" | "mcp";

export type ToolErrorCode = "invalid_input" | "permission_denied" | "not_found" | "timeout" | "unavailable" | "cancelled" | "failed";

/** A failure the model should see and may recover from (bad path, non-zero exit, blocked URL...). */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError || (error instanceof Error && error.name === "ToolError" && typeof (error as ToolError).code === "string");
}

/** Activity a tool reports while running; the runtime turns it into timeline events. */
export type ToolActivity =
  | { type: "FILE_READ"; path: string; bytes: number }
  | { type: "FILE_CREATED"; path: string; bytes: number }
  | { type: "FILE_UPDATED"; path: string; bytes: number }
  | { type: "TERMINAL_COMMAND_STARTED"; command: string; cwd: string }
  | { type: "TERMINAL_COMMAND_FINISHED"; command: string; cwd: string; exitCode: number | null; timedOut: boolean; durationMs: number }
  | { type: "PAGE_READ"; url: string; title: string | null; status: number; bytes: number }
  | { type: "MCP_TOOL_STARTED"; serverId: string; serverName: string; tool: string }
  | { type: "MCP_TOOL_FINISHED"; serverId: string; serverName: string; tool: string; isError: boolean; durationMs: number }
  | { type: "BROWSER_OPENED" }
  | { type: "PAGE_NAVIGATED"; url: string; title: string | null }
  | { type: "BROWSER_ACTION"; action: BrowserActionKind; target: string; url: string }
  | { type: "BROWSER_SCREENSHOT"; url: string; title: string | null; width: number; height: number; mimeType: "image/jpeg"; image: Uint8Array; reason: string }
  | { type: "BROWSER_CLOSED" }
  | { type: "COMPUTER_STARTED"; platform: string; screenWidth: number; screenHeight: number }
  | { type: "COMPUTER_ACTION"; action: ComputerActionKind; target: string }
  | { type: "COMPUTER_SCREENSHOT"; width: number; height: number; mimeType: "image/jpeg"; image: Uint8Array; reason: string }
  | { type: "COMPUTER_STOPPED" }
  | { type: "TASK_DELEGATED"; taskId: string; agentId: string; agentName: string; instruction: string }
  | { type: "SUBTASK_FINISHED"; taskId: string; agentName: string; status: string; inputTokens: number; outputTokens: number };

export type ComputerActionKind = "move" | "click" | "double_click" | "right_click" | "drag" | "scroll" | "type" | "key" | "wait";

export type BrowserActionKind = "click" | "type" | "select" | "press" | "scroll" | "back";

export interface ToolContext {
  taskId: string;
  userId: string;
  workspace: Workspace;
  /** Aborts on stop, task time limit or the tool's own timeout. */
  signal: AbortSignal;
  report(activity: ToolActivity): void;
  /** Live process output for terminal views. */
  output(stream: "stdout" | "stderr", text: string): void;
}

export interface ToolResult {
  /** JSON-serialisable result stored with the tool call and shown in the Tools tab. */
  output: unknown;
  /** One-line human summary for the timeline. */
  summary: string;
  /** What the model receives. Defaults to JSON of `output`. */
  content?: string;
  /** Images the model should see with the result (screenshots). */
  images?: { mimeType: "image/jpeg" | "image/png" | "image/webp"; data: Buffer }[];
  /** Model usage incurred by the tool itself (e.g. grounded search). */
  usage?: { provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface ToolAvailability {
  available: boolean;
  reason?: string;
}

export interface ToolDefinition<Input = unknown> {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: z.ZodType<Input>;
  /** JSON Schema for the model; derived from `inputSchema` when omitted. */
  parameters?: Record<string, unknown>;
  /** Static level, or computed from the input (e.g. a destructive terminal command). */
  permission: PermissionLevel | ((input: Input) => PermissionLevel);
  timeoutMs: number;
  availability(): ToolAvailability;
  execute(input: Input, context: ToolContext): Promise<ToolResult>;
}

// Tools are stored heterogeneously; `any` keeps each definition's input type intact at registration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any>;

/** Supplies tools that depend on the user (e.g. their MCP servers), alongside the static built-in registry. */
export interface ToolSource {
  toolsForUser(userId: string): Promise<AnyToolDefinition[]>;
}
