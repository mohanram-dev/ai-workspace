import { readFile, stat } from "node:fs/promises";
import type { ImageAttachment } from "@aiw/ai";
import type { MessageAttachment } from "@aiw/shared";
import { attachmentContent, attachmentSizeLimit } from "@aiw/tools";
import { resolveWorkspace } from "@/server/files";
import { HttpError } from "@/server/http";

export interface PreparedAttachments {
  /** Images for the model to look at. */
  images: ImageAttachment[];
  /** Text extracted from non-image files, appended to the prompt. */
  text: string;
}

/**
 * Checks what the user attached (spec §3) before anything is stored: each file
 * must still be in the workspace it names, through the workspace guard so a
 * crafted path cannot escape, and within the size limit. Returns the resolved
 * paths. A failure here is a 4xx for the request, not a half-stored message.
 */
export async function checkAttachments(userId: string, attachments: MessageAttachment[]): Promise<string[]> {
  const paths: string[] = [];
  for (const attachment of attachments) {
    const { workspace } = await resolveWorkspace(userId, attachment.projectId ?? null);
    let absolute: string;
    try {
      absolute = await workspace.resolve(attachment.path, { mustExist: true });
    } catch {
      throw new HttpError(400, "bad_request", `The attachment "${attachment.name}" is no longer in your workspace.`);
    }
    const info = await stat(absolute);
    if (!info.isFile()) throw new HttpError(400, "bad_request", `"${attachment.name}" is not a file.`);
    const limit = attachmentSizeLimit(attachment.name, attachment.mimeType);
    if (info.size > limit) {
      throw new HttpError(413, "bad_request", `"${attachment.name}" is larger than ${limit / 1024 / 1024} MB.`);
    }
    paths.push(absolute);
  }
  return paths;
}

/**
 * Reads what the user attached to a chat message. Images go to the model as
 * pictures; anything else as text — a PDF's text layer included — which is the
 * only honest thing to do with a file a text model cannot see.
 */
export async function prepareAttachments(userId: string, attachments: MessageAttachment[]): Promise<PreparedAttachments> {
  const images: ImageAttachment[] = [];
  const notes: string[] = [];
  const paths = await checkAttachments(userId, attachments);

  for (const [index, attachment] of attachments.entries()) {
    const content = await attachmentContent(attachment.name, attachment.mimeType, await readFile(paths[index]!));
    if (content.kind === "image") images.push({ mimeType: content.mimeType, data: content.data.toString("base64") });
    else notes.push(content.text);
  }

  return { images, text: notes.join("\n\n") };
}
