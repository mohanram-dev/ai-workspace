import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getServerEnv } from "@/server/env";
import { MAX_UPLOAD_BYTES, resolveWorkspace, toHttpError } from "@/server/files";
import { assertSameOrigin, errorResponse, HttpError } from "@/server/http";
import { requireApiSession } from "@/server/session";

const fieldsSchema = z.object({
  /** Directory to upload into, relative to the workspace root. */
  directory: z.string().max(1024).default("."),
  projectId: z.uuid().nullish(),
});

const RESERVED_NAME_CHARS = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);

/** Replaces path separators, reserved characters and control codes with underscores. */
function safeFileName(raw: string): string {
  const base = path.basename(raw || "upload");
  let name = "";
  for (const character of base) {
    const code = character.codePointAt(0) ?? 0;
    name += RESERVED_NAME_CHARS.has(character) || code < 32 || code === 127 ? "_" : character;
  }
  return name.trim().slice(0, 200) || "upload";
}

/** POST /api/files/upload — multipart upload of one file into a workspace folder. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const form = await request.formData().catch(() => null);
    if (!form) throw new HttpError(400, "bad_request", "Send the file as multipart form data.");
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "bad_request", "No file was included.");
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, "bad_request", `Files must be ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB or smaller.`);
    }

    const fields = fieldsSchema.safeParse({ directory: form.get("directory") ?? ".", projectId: form.get("projectId") || null });
    if (!fields.success) throw new HttpError(400, "bad_request", "Invalid upload target.");
    const { workspace } = await resolveWorkspace(user.id, fields.data.projectId);

    // The uploaded name is untrusted: reduce it to a safe basename, then
    // resolve it through the workspace guard.
    const safeName = safeFileName(file.name);
    try {
      const directory = await workspace.resolve(fields.data.directory);
      await mkdir(directory, { recursive: true });
      const relativeDirectory = workspace.relative(directory);
      const target = await workspace.resolve(relativeDirectory === "." ? safeName : `${relativeDirectory}/${safeName}`);
      const bytes = Buffer.from(await file.arrayBuffer());
      let written = target;
      try {
        await writeFile(target, bytes, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Never silently overwrite an existing file.
        const parsed = path.parse(target);
        written = path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
        await writeFile(written, bytes, { flag: "wx" });
      }
      return Response.json({ path: workspace.relative(written), size: bytes.length }, { status: 201 });
    } catch (error) {
      toHttpError(error);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
