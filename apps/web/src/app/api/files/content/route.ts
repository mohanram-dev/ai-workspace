import { filePathQuerySchema, type FileContentDto } from "@aiw/shared";
import { readFileBytes, readTextFile, resolveWorkspace, toHttpError } from "@/server/files";
import { errorResponse, HttpError } from "@/server/http";
import { requireApiSession } from "@/server/session";

/**
 * GET /api/files/content?path=&projectId=&download=1 — a file's text for the
 * viewer, or its bytes as an attachment when `download` is set.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const params = new URL(request.url).searchParams;
    const query = filePathQuerySchema.safeParse(Object.fromEntries(params));
    if (!query.success) throw new HttpError(400, "bad_request", "Invalid query parameters.");
    const { workspace } = await resolveWorkspace(user.id, query.data.projectId);

    try {
      if (params.get("download")) {
        const file = await readFileBytes(workspace, query.data.path);
        return new Response(new Uint8Array(file.bytes), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(file.size),
            "Content-Disposition": `attachment; filename="${file.name.replace(/[^\w.\- ]+/g, "_")}"`,
            "Cache-Control": "private, no-store",
          },
        });
      }
      const body: FileContentDto = await readTextFile(workspace, query.data.path);
      return Response.json(body);
    } catch (error) {
      toHttpError(error);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
