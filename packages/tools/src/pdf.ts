import { getDocumentProxy } from "unpdf";
import { ToolError } from "./types";

/** Largest PDF read. Bigger files are refused rather than parsed for minutes. */
export const MAX_PDF_BYTES = 30 * 1024 * 1024;
/** Pages read from one PDF; later pages are reported as not read. */
export const MAX_PDF_PAGES = 300;

const PAGE_MARKER = /^--- Page \d+ ---$/gm;

/** True when the bytes are a PDF. The header may follow a little junk, which readers accept. */
export function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 1024)).toString("latin1").includes("%PDF-");
}

/** A path that names a PDF, for deciding size limits before the bytes are read. */
export function looksLikePdf(name: string, mimeType?: string | null): boolean {
  return mimeType === "application/pdf" || /\.pdf$/i.test(name);
}

export interface PdfText {
  /** Page texts, each under a "--- Page N ---" marker so answers can cite pages. */
  text: string;
  totalPages: number;
  pagesRead: number;
  /** False for a PDF with no text layer (scanned pages): there is nothing to read without OCR. */
  hasText: boolean;
}

/**
 * The text layer of a PDF, page by page. Extraction only: a scanned PDF has no
 * text layer and comes back with `hasText: false` rather than an invented
 * transcription.
 */
export async function extractPdfText(bytes: Uint8Array, options: { maxPages?: number; signal?: AbortSignal } = {}): Promise<PdfText> {
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new ToolError("invalid_input", `The PDF is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB, too large to read.`);
  }
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js takes ownership of the buffer it is handed, so it gets a copy.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (error) {
    throw new ToolError("invalid_input", describePdfError(error));
  }
  try {
    const pagesRead = Math.min(pdf.numPages, options.maxPages ?? MAX_PDF_PAGES);
    const pages: string[] = [];
    for (let number = 1; number <= pagesRead; number++) {
      if (options.signal?.aborted) throw new ToolError("cancelled", "Reading the PDF was stopped.");
      const content = await (await pdf.getPage(number)).getTextContent();
      // The same joining unpdf's own extractText uses: a line break where the item ends one.
      const raw = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
      pages.push(`--- Page ${number} ---\n${normalise(raw)}`);
    }
    const text = pages.join("\n\n");
    return { text, totalPages: pdf.numPages, pagesRead, hasText: text.replace(PAGE_MARKER, "").trim().length > 0 };
  } finally {
    // How unpdf releases a document it opened itself.
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

/** Collapses runs of spaces without losing line structure; at most one blank line survives. */
function normalise(text: string): string {
  return text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function describePdfError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") return "The PDF is password-protected, so it cannot be read.";
  if (name === "InvalidPDFException") return "The file is not a valid PDF.";
  return "The PDF could not be read; it may be damaged.";
}
