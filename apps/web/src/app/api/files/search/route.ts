import { fileSearchQuerySchema } from "@aiw/shared";
import { resolveWorkspace, searchFiles, toHttpError } from "@/server/files";
import { errorResponse, HttpError } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** GET /api/files/search?query=&projectId= — files whose name contains the query (spec §24). */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const query = fileSearchQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new HttpError(400, "bad_request", "Give a search query.");
    const { workspace, info } = await resolveWorkspace(user.id, query.data.projectId);
    try {
      const result = await searchFiles(workspace, query.data.query);
      return Response.json({ workspace: info, query: query.data.query, ...result });
    } catch (error) {
      toHttpError(error);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
