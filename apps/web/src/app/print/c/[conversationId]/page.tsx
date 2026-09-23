import { getConversationForUser, getDatabase, getTaskForUser, listMessages } from "@aiw/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/features/chat/markdown";
import { PrintOnLoad } from "@/features/conversations/print-on-load";
import { isUuid } from "@/server/http";
import { requirePageSession } from "@/server/session";

const dateFormatter = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

async function load(conversationId: string) {
  const { user } = await requirePageSession();
  if (!isUuid(conversationId)) notFound();
  const db = getDatabase();
  const conversation = await getConversationForUser(db, user.id, conversationId);
  if (!conversation) notFound();
  return { db, user, conversation };
}

export async function generateMetadata({ params }: PageProps<"/print/c/[conversationId]">): Promise<Metadata> {
  // The document title becomes the suggested PDF file name.
  const { conversation } = await load((await params).conversationId);
  return { title: conversation.title };
}

/**
 * A conversation laid out for paper, outside the workspace shell, that opens
 * the print dialog: "Save as PDF" there is the PDF export, with no PDF library.
 */
export default async function PrintConversationPage({ params }: PageProps<"/print/c/[conversationId]">) {
  const { db, user, conversation } = await load((await params).conversationId);
  const messages = (await listMessages(db, conversation.id)).filter((m) => m.role !== "system");
  const agentNames = new Map<string, string>();
  for (const taskId of new Set(messages.flatMap((m) => (m.taskId ? [m.taskId] : [])))) {
    const task = await getTaskForUser(db, user.id, taskId);
    if (task?.agent) agentNames.set(taskId, task.agent.name);
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 print:max-w-none print:p-0">
      <PrintOnLoad />
      <h1 className="text-2xl font-semibold tracking-tight">{conversation.title}</h1>
      <p className="mt-1 text-xs text-muted-foreground">
        {messages.length} message{messages.length === 1 ? "" : "s"} · printed from AI Workspace
      </p>
      {messages.map((message) => {
        const who = message.role === "user" ? "You" : ((message.taskId && agentNames.get(message.taskId)) ?? "Assistant");
        return (
          <article key={message.id} className="mt-6 border-t pt-4">
            <p className="text-xs font-medium text-muted-foreground">
              {who} · {dateFormatter.format(message.createdAt)}
              {message.model ? ` · ${message.model}` : ""}
              {message.role === "assistant" && message.status !== "completed" ? ` · ${message.status}` : ""}
            </p>
            {message.role === "user" ? (
              <p className="mt-2 text-[0.9375rem] leading-7 break-words whitespace-pre-wrap">{message.content}</p>
            ) : (
              <Markdown content={message.content || "(no reply)"} className="mt-2" />
            )}
            {message.error && <p className="mt-2 text-sm text-destructive">Error: {message.error}</p>}
            {(message.attachments ?? []).length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">Attachments: {message.attachments!.map((a) => a.name).join(", ")}</p>
            )}
          </article>
        );
      })}
    </main>
  );
}
