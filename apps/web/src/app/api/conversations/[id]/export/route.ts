import { getConversationForUser, getDatabase, getTaskForUser, listMessages, type TaskWithAgent } from "@aiw/database";
import { conversationMarkdown, downloadHeaders, exportFilename } from "@/server/export";
import { errorResponse, HttpError, isUuid } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** GET /api/conversations/:id/export — the conversation as a Markdown file. */
export async function GET(request: Request, ctx: RouteContext<"/api/conversations/[id]/export">): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "Conversation not found.");
    const db = getDatabase();
    const conversation = await getConversationForUser(db, user.id, id);
    if (!conversation) throw new HttpError(404, "not_found", "Conversation not found.");

    const messages = await listMessages(db, conversation.id);
    // Agent replies are named after the agent that wrote them.
    const tasks = new Map<string, TaskWithAgent>();
    for (const taskId of new Set(messages.flatMap((m) => (m.taskId ? [m.taskId] : [])))) {
      const task = await getTaskForUser(db, user.id, taskId);
      if (task) tasks.set(task.id, task);
    }
    return new Response(conversationMarkdown(conversation, messages, tasks), {
      headers: downloadHeaders(exportFilename(conversation.title, "md"), "text/markdown; charset=utf-8"),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
