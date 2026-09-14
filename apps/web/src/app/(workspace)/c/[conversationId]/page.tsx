import { getConversationForUser, getDatabase, listMessages } from "@aiw/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChatView } from "@/features/chat/chat-view";
import { toConversationDto, toMessageDto } from "@/server/dto";
import { isUuid } from "@/server/http";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "Conversation" };

export default async function ConversationPage({ params }: PageProps<"/c/[conversationId]">) {
  const { conversationId } = await params;
  if (!isUuid(conversationId)) notFound();

  const { user } = await requirePageSession();
  const db = getDatabase();
  const conversation = await getConversationForUser(db, user.id, conversationId);
  if (!conversation) notFound();

  const messages = await listMessages(db, conversation.id);

  return (
    <ChatView
      key={conversation.id}
      conversation={{ ...toConversationDto(conversation), messages: messages.map((m) => toMessageDto(m)) }}
    />
  );
}
