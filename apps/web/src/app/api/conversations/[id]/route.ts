import {
  deleteConversationForUser,
  getConversationForUser,
  getDatabase,
  listMessages,
  updateConversationForUser,
  writeAuditLog,
} from "@aiw/database";
import { updateConversationSchema, type ConversationWithMessagesDto } from "@aiw/shared";
import { toConversationDto, toMessageDto } from "@/server/dto";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid, readJson } from "@/server/http";
import { requireApiSession } from "@/server/session";

type Context = RouteContext<"/api/conversations/[id]">;

async function conversationId(ctx: Context): Promise<string> {
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new HttpError(404, "not_found", "Conversation not found.");
  return id;
}

export async function GET(request: Request, ctx: Context): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const id = await conversationId(ctx);
    const db = getDatabase();

    const conversation = await getConversationForUser(db, user.id, id);
    if (!conversation) throw new HttpError(404, "not_found", "Conversation not found.");

    const messages = await listMessages(db, id);
    const body: ConversationWithMessagesDto = {
      ...toConversationDto(conversation),
      messages: messages.map((m) => toMessageDto(m)),
    };
    return Response.json(body);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await conversationId(ctx);
    const changes = await readJson(request, updateConversationSchema);

    const updated = await updateConversationForUser(getDatabase(), user.id, id, changes);
    if (!updated) throw new HttpError(404, "not_found", "Conversation not found.");
    return Response.json(toConversationDto(updated));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await conversationId(ctx);
    const db = getDatabase();

    const deleted = await deleteConversationForUser(db, user.id, id);
    if (!deleted) throw new HttpError(404, "not_found", "Conversation not found.");

    await writeAuditLog(db, {
      userId: user.id,
      action: "conversation.deleted",
      resourceType: "conversation",
      resourceId: id,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
