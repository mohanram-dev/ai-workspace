export type ToolPermissionLevel = "READ" | "WRITE" | "EXECUTE" | "NETWORK" | "DESTRUCTIVE";

/** A tool available on this server, as shown in the agent editor. */
export interface ToolInfoDto {
  name: string;
  description: string;
  category: "files" | "terminal" | "git" | "web" | "browser" | "computer" | "memory" | "agent" | "docker" | "ssh" | "github" | "mcp";
  permission: ToolPermissionLevel | "DYNAMIC";
  available: boolean;
  unavailableReason: string | null;
  /** Set for MCP tools. */
  server?: { id: string; name: string; slug: string };
}

export type ToolCallStatus = "running" | "awaiting_approval" | "completed" | "failed" | "denied" | "cancelled";

export interface ToolCallDto {
  id: string;
  stepId: string | null;
  toolName: string;
  category: string | null;
  permission: string | null;
  status: ToolCallStatus;
  input: unknown;
  output: unknown;
  summary: string | null;
  error: string | null;
  errorCode: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

/** Ephemeral terminal output for a running terminal.run call. */
export interface TerminalOutputDelta {
  taskId: string;
  toolCallId: string;
  stream: "stdout" | "stderr";
  text: string;
}

/** A screenshot captured by the browser tools, listed with the task. */
export interface ScreenshotDto {
  id: string;
  toolCallId: string | null;
  url: string;
  title: string | null;
  width: number;
  height: number;
  bytes: number;
  reason: string;
  /** Which capability captured it. */
  source: "browser" | "computer";
  createdAt: string;
}
