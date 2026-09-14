import { z } from "zod";
import type { ToolPermissionLevel } from "./tools";

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "cancelled"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** "once" runs just this call; "task" also approves later calls of the same tool in this task. */
export const APPROVAL_SCOPES = ["once", "task"] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

export const approveRequestSchema = z.object({ scope: z.enum(APPROVAL_SCOPES).default("once") });
export const rejectRequestSchema = z.object({ reason: z.string().trim().max(500).optional() });

export interface ApprovalRequestDto {
  id: string;
  taskId: string;
  toolCallId: string;
  agent: { id: string; name: string } | null;
  toolName: string;
  permission: ToolPermissionLevel;
  /** One line describing what the agent wants to do, e.g. `rm -rf build`. */
  action: string;
  input: unknown;
  status: ApprovalStatus;
  scope: ApprovalScope | null;
  reason: string | null;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
  /** Present when listing approvals outside a task page. */
  taskPrompt?: string;
}
