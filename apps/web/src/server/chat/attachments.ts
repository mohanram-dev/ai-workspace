import { readFile, stat } from "node:fs/promises";
import type { ImageAttachment } from "@aiw/ai";
import { isAttachableImage, MAX_ATTACHMENT_TEXT_CHARS, type MessageAttachment } from "@aiw/shared";
import { resolveWorkspace } from "@/server/files";
import { HttpError } from "@/server/http";

/** Bytes read from one attachment. Images cost tokens, so this is deliberately modest. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** How much of a file is inspected to decide whether it is text. */
const BINARY_PROBE_BYTES = 4096;

export interface PreparedAttachments {
  /** Images for the model to look at. */
  images: ImageAttachment[];
  /** Text extracted from non-image files, appended to the prompt. */
  text: string;
}

/**
 * Reads what the user attached (spec §3) from local disk through the workspace
 * guard, so a crafted path cannot escape the user's own workspace. Images go to
 * the model as pictures; anything else is read as text, which is the only
 * honest thing to do with a file a text model cannot see.
 */
export async function prepareAttachments(userId: string, attachments: MessageAttachment[]): Promise<PreparedAttachments> {
  const images: ImageAttachment[] = [];
  const notes: string[] = [];

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
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new HttpError(413, "bad_request", `"${attachment.name}" is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    }

    const bytes = await readFile(absolute);
    if (isAttachableImage(attachment.mimeType)) {
      images.push({ mimeType: attachment.mimeType as ImageAttachment["mimeType"], data: bytes.toString("base64") });
      continue;
    }

    // Not an image: read it as text when it is text, and say plainly when it is
    // not, rather than sending the model rubbish. A zero byte early in the file
    // is the reliable signal that this is binary.
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
      notes.push(`[Attached file "${attachment.name}" (${attachment.mimeType}) is neither text nor an image, so its contents could not be read.]`);
      continue;
    }
    const text = bytes.toString("utf8");
    const clipped = text.length > MAX_ATTACHMENT_TEXT_CHARS ? `${text.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n… (truncated)` : text;
    notes.push(`--- Attached file: ${attachment.name} ---\n${clipped}`);
  }

  return { images, text: notes.join("\n\n") };
}
