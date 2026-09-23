import { isAttachableImage, MAX_ATTACHMENT_TEXT_CHARS } from "@aiw/shared";
import { extractPdfText, isPdf, looksLikePdf, MAX_PDF_BYTES } from "./pdf";
import { isToolError } from "./types";

/** Bytes read from one attachment that is not a PDF. Images cost tokens, so this is deliberately modest. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** How much of a file is inspected to decide whether it is text. */
const BINARY_PROBE_BYTES = 4096;

/** The largest file of this kind that may be attached. A PDF becomes bounded text, so it may be bigger. */
export function attachmentSizeLimit(name: string, mimeType: string): number {
  return looksLikePdf(name, mimeType) ? MAX_PDF_BYTES : MAX_ATTACHMENT_BYTES;
}

export type AttachmentContent =
  | { kind: "image"; mimeType: "image/jpeg" | "image/png" | "image/webp"; data: Buffer }
  /** Text for the prompt, under a header naming the file, or a note saying why there is none. */
  | { kind: "text"; text: string };

/**
 * What a model can take from one attached file (spec §3), shared by chat and
 * agent tasks: an image to look at, or text — a PDF's text layer included. A
 * file that cannot be read becomes a plain note saying so, never rubbish.
 */
export async function attachmentContent(name: string, mimeType: string, bytes: Buffer): Promise<AttachmentContent> {
  if (isAttachableImage(mimeType)) return { kind: "image", mimeType: mimeType as "image/jpeg" | "image/png" | "image/webp", data: bytes };
  // Checked before the binary probe: a PDF often has no zero byte in its
  // first kilobytes, and would otherwise be sent to the model as mojibake.
  if (isPdf(bytes)) return { kind: "text", text: await pdfText(name, bytes) };
  // A zero byte early in the file is the reliable signal that it is binary.
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return { kind: "text", text: `[Attached file "${name}" (${mimeType}) is neither text nor an image, so its contents could not be read.]` };
  }
  return { kind: "text", text: `--- Attached file: ${name} ---\n${clip(bytes.toString("utf8"))}` };
}

async function pdfText(name: string, bytes: Buffer): Promise<string> {
  try {
    const pdf = await extractPdfText(bytes);
    if (!pdf.hasText) {
      return `[Attached PDF "${name}" has no text layer (its pages are probably scanned images), so its contents could not be read.]`;
    }
    const pages = pdf.pagesRead < pdf.totalPages ? `, first ${pdf.pagesRead} of ${pdf.totalPages} pages` : `, ${pdf.totalPages} page${pdf.totalPages === 1 ? "" : "s"}`;
    return `--- Attached PDF: ${name}${pages} ---\n${clip(pdf.text)}`;
  } catch (error) {
    return `[Attached PDF "${name}" could not be read: ${isToolError(error) ? error.message : "it may be damaged."}]`;
  }
}

function clip(text: string): string {
  return text.length > MAX_ATTACHMENT_TEXT_CHARS ? `${text.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n… (truncated)` : text;
}
