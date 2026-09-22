import { filePathQuerySchema, type FileContentDto } from "@aiw/shared";
import { previewFor, readFileBytes, readTextFile, resolveWorkspace, toHttpError } from "@/server/files";
import { errorResponse, HttpError } from "@/server/http";
import { requireApiSession } from "@/server/session";

/**
 * GET /api/files/content?path=&projectId=&download=1&raw=1 — a file's text for
 * the viewer, its bytes as an attachment when `download` is set, or its bytes
 * inline for the image/PDF/audio/video viewer when `raw` is set.
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
      if (params.get("raw")) {
        // Only the allowlisted types are served inline, and only with the type
        // the allowlist chose — never one sniffed from the bytes or taken from
        // the request — so a file cannot be made to run as script on this
        // origin. `sandbox` covers opening the URL directly in a tab.
        const preview = previewFor(query.data.path);
        if (!preview) throw new HttpError(415, "bad_request", "That file type cannot be shown in the browser. Download it instead.");
        const file = await readFileBytes(workspace, query.data.path);
        return new Response(new Uint8Array(file.bytes), {
          headers: {
            "Content-Type": preview.mediaType,
            "Content-Length": String(file.size),
            "Content-Disposition": `inline; filename="${file.name.replace(/[^\w.\- ]+/g, "_")}"`,
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "X-Content-Type-Options": "nosniff",
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
