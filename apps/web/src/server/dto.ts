import type { Conversation, Message } from "@aiw/database";
import { STALE_STREAM_MS, type ConversationDto, type MessageDto } from "@aiw/shared";

export { STALE_STREAM_MS };

/** Chat replies only: task replies follow their task status, which restart recovery keeps accurate. */
export function isStaleStream(message: Pick<Message, "status" | "createdAt" | "taskId">, now = Date.now()): boolean {
  return message.taskId === null && message.status === "streaming" && now - message.createdAt.getTime() > STALE_STREAM_MS;
}

export function toConversationDto(row: Conversation): ConversationDto {
  return {
    id: row.id,
    title: row.title,
    pinned: row.pinned,
    archived: row.archivedAt !== null,
    projectId: row.projectId,
    lastMessageAt: row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMessageDto(row: Message, now = Date.now()): MessageDto {
  const stale = isStaleStream(row, now);
  return {
    id: row.id,
    taskId: row.taskId,
    role: row.role,
    content: row.content,
    status: stale ? "failed" : row.status,
    provider: row.provider,
    model: row.model,
    error: stale ? "Generation was interrupted before it finished." : row.error,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    attachments: row.attachments ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}
