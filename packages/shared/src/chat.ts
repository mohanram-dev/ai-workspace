import { z } from "zod";

export const MAX_MESSAGE_LENGTH = 32_000;

/** A non-task message still marked `streaming` after this long was interrupted (e.g. server restart). */
export const STALE_STREAM_MS = 10 * 60 * 1000;

/** Images the model can look at; anything else is attached as text. */
export const ATTACHABLE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** Attachments per message, and how much text is read from a non-image file. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_TEXT_CHARS = 20_000;

/**
 * A file the user attached to a message (spec §3). The bytes stay in the
 * workspace on local disk; only this reference travels with the message.
 */
export const messageAttachmentSchema = z.object({
  /** Path relative to the workspace root, as returned by the upload. */
  path: z.string().trim().min(1).max(1024),
  name: z.string().trim().min(1).max(300),
  mimeType: z.string().trim().min(1).max(200),
  size: z.number().int().min(0),
  projectId: z.uuid().nullish(),
});

export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export function isAttachableImage(mimeType: string): boolean {
  return (ATTACHABLE_IMAGE_TYPES as readonly string[]).includes(mimeType);
}

export const sendChatMessageSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    /** Omit to start a new conversation. */
    conversationId: z.uuid().optional(),
    content: z.string().trim().min(1, "Message cannot be empty").max(MAX_MESSAGE_LENGTH),
    model: z.string().min(1).max(200).optional(),
    attachments: z.array(messageAttachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  }),
  z.object({
    /** Regenerate the last assistant reply of an existing conversation. */
    action: z.literal("retry"),
    conversationId: z.uuid(),
    model: z.string().min(1).max(200).optional(),
  }),
]);

export type SendChatMessageInput = z.infer<typeof sendChatMessageSchema>;

export const messageRoleSchema = z.enum(["user", "assistant", "system"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const messageStatusSchema = z.enum(["streaming", "completed", "failed", "cancelled"]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

/**
 * Events streamed from POST /api/chat. Strongly typed on both ends; the
 * client validates each event with this schema before applying it.
 */
export const chatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    conversationId: z.uuid(),
    conversationTitle: z.string(),
    userMessageId: z.uuid().nullable(),
    assistantMessageId: z.uuid(),
    provider: z.string(),
    model: z.string(),
  }),
  z.object({
    type: z.literal("delta"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    status: z.enum(["completed", "cancelled"]),
    finishReason: z.string(),
    usage: tokenUsageSchema,
    estimatedCostUsd: z.number().nullable(),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

/** Message shape returned by the conversations API. */
export interface MessageDto {
  id: string;
  /** Set when the assistant message is produced by an agent task. */
  taskId: string | null;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  provider: string | null;
  model: string | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  attachments: MessageAttachment[];
  createdAt: string;
}

export interface ModelDto {
  id: string;
  label: string;
  provider: string;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
}

export interface ModelsResponse {
  defaultModel: string | null;
  providers: { id: string; name: string; configured: boolean }[];
  models: ModelDto[];
  /** Set when the live model list could not be loaded. */
  error: string | null;
}
