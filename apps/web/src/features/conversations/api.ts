import type { ConversationDto, ConversationWithMessagesDto, UpdateConversationInput } from "@aiw/shared";
import { apiFetch } from "@/lib/api-client";

export async function fetchConversations(options: { q?: string; archived?: boolean } = {}): Promise<ConversationDto[]> {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
  if (options.archived) params.set("archived", "true");
  const query = params.toString();
  const { conversations } = await apiFetch<{ conversations: ConversationDto[] }>(
    `/api/conversations${query ? `?${query}` : ""}`,
  );
  return conversations;
}

export function fetchConversation(id: string): Promise<ConversationWithMessagesDto> {
  return apiFetch(`/api/conversations/${id}`);
}

export function updateConversation(id: string, changes: UpdateConversationInput): Promise<ConversationDto> {
  return apiFetch(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify(changes) });
}

export function deleteConversation(id: string): Promise<void> {
  return apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
}
