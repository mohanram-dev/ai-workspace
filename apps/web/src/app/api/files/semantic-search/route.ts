import { semanticSearch } from "@aiw/agents";
import { getDatabase } from "@aiw/database";
import { fileSearchQuerySchema, type SemanticSearchResultDto } from "@aiw/shared";
import { isToolError } from "@aiw/tools";
import { getServerEnv } from "@/server/env";
import { resolveWorkspace } from "@/server/files";
import { errorResponse, HttpError } from "@/server/http";
import { getProviderRegistry } from "@/server/providers";
import { requireApiSession } from "@/server/session";

/**
 * GET /api/files/semantic-search?query=&projectId= — passages whose meaning
 * matches the query, from the same index agents use. May embed files that
 * changed since the last search, so the page asks for it explicitly.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const query = fileSearchQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new HttpError(400, "bad_request", "Give a search query.");
    const env = getServerEnv();
    const { workspace, info } = await resolveWorkspace(user.id, query.data.projectId);
    try {
      const outcome = await semanticSearch(
        {
          db: getDatabase(),
          registry: getProviderRegistry(),
          provider: env.EMBEDDING_PROVIDER === "none" ? null : env.EMBEDDING_PROVIDER,
          model: env.EMBEDDING_MODEL,
        },
        { userId: user.id, projectId: info.id, workspace, query: query.data.query, maxResults: 10, signal: request.signal },
      );
      const body: SemanticSearchResultDto = { query: query.data.query, ...outcome };
      return Response.json(body);
    } catch (error) {
      if (isToolError(error)) throw new HttpError(error.code === "unavailable" ? 503 : 502, "internal_error", error.message);
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
