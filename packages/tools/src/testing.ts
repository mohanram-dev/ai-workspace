// Test fixtures shared with other packages' tests (import from "@aiw/tools/testing").

/**
 * A small but real PDF with one line of text per page, for tests that must go
 * through an actual PDF parser. An empty string gives a page with no text
 * layer, like a scanned one. The binary comment after the header has no zero
 * byte, as in many real PDFs, so a "binary = has a NUL" probe does not see it.
 */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const pageId = (index: number) => 4 + index * 2;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const stream = text ? `BT /F1 12 Tf 20 100 Td (${text.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET` : "";
    objects[pageId(i)] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId(i) + 1} 0 R >>`;
    objects[pageId(i) + 1] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
