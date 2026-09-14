import { getDatabase, listConversations } from "@aiw/database";
import { listConversationsQuerySchema } from "@aiw/shared";
import { toConversationDto } from "@/server/dto";
import { errorResponse, HttpError } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** GET /api/conversations?q=&archived=true|false&limit= */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const query = listConversationsQuerySchema.safeParse(params);
    if (!query.success) throw new HttpError(400, "bad_request", "Invalid query parameters.");

    const rows = await listConversations(getDatabase(), user.id, query.data);
    return Response.json({ conversations: rows.map(toConversationDto) });
  } catch (error) {
    return errorResponse(error);
  }
}
