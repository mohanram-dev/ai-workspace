import { filePathQuerySchema, type FileListDto } from "@aiw/shared";
import { listDirectory, resolveWorkspace, toHttpError } from "@/server/files";
import { errorResponse, HttpError } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** GET /api/files?path=&projectId= — one directory of a workspace. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const query = filePathQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new HttpError(400, "bad_request", "Invalid query parameters.");

    const { workspace, info } = await resolveWorkspace(user.id, query.data.projectId);
    await workspace.ensure();
    try {
      const listing = await listDirectory(workspace, query.data.path);
      const body: FileListDto = { ...listing, workspace: info };
      return Response.json(body);
    } catch (error) {
      toHttpError(error);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
