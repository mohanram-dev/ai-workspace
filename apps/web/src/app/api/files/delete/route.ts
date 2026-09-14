import { unlink } from "node:fs/promises";
import { getServerEnv } from "@/server/env";
import { resolveWorkspace, toHttpError } from "@/server/files";
import { assertSameOrigin, errorResponse } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** POST /api/files/delete?path=&projectId= — remove one file from a workspace. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const params = new URL(request.url).searchParams;
    const { workspace } = await resolveWorkspace(user.id, params.get("projectId"));
    try {
      const target = await workspace.resolve(params.get("path") ?? "", { mustExist: true });
      await unlink(target);
      return new Response(null, { status: 204 });
    } catch (error) {
      toHttpError(error);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
