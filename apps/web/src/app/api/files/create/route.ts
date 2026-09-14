import { createFileSchema } from "@aiw/shared";
import { getDatabase, writeAuditLog } from "@aiw/database";
import { getServerEnv } from "@/server/env";
import { createTextFile, resolveWorkspace, toHttpError } from "@/server/files";
import { assertSameOrigin, errorResponse, readJson } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** POST /api/files/create — a new text file in the workspace (spec §24). Never overwrites. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const input = await readJson(request, createFileSchema);
    const { workspace } = await resolveWorkspace(user.id, input.projectId);
    try {
      const entry = await createTextFile(workspace, input.path, input.content);
      await writeAuditLog(getDatabase(), { userId: user.id, action: "file.created", resourceType: "file", resourceId: entry.path, metadata: { size: entry.size } });
      return Response.json(entry, { status: 201 });
    } catch (error) {
      toHttpError(error);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
