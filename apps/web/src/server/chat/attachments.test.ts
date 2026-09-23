import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makePdf } from "@aiw/tools/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let root: string;
let prepareAttachments: typeof import("./attachments").prepareAttachments;
const userId = randomUUID();

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aiw-attachments-"));
  // The workspace root comes from the server environment, read once per process.
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://aiw:aiw@localhost:5432/aiw_test",
    APP_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "x".repeat(48),
    WORKSPACE_ROOT: root,
  });
  vi.resetModules();
  ({ prepareAttachments } = await import("./attachments"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function attach(name: string, bytes: Buffer) {
  const dir = path.join(root, "users", userId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), bytes);
  return { path: name, name, mimeType: "application/pdf", size: bytes.length, projectId: null };
}

describe("prepareAttachments with PDFs", () => {
  it("sends a PDF's text to the model, page by page, instead of its bytes", async () => {
    const prepared = await prepareAttachments(userId, [await attach("minutes.pdf", makePdf(["Budget approved", "Launch in May"]))]);
    expect(prepared.images).toEqual([]);
    expect(prepared.text).toContain("--- Attached PDF: minutes.pdf, 2 pages ---");
    expect(prepared.text).toContain("--- Page 1 ---\nBudget approved");
    expect(prepared.text).toContain("--- Page 2 ---\nLaunch in May");
    // Before, a PDF with no zero byte early on was pasted in as raw PDF syntax.
    expect(prepared.text).not.toContain("endobj");
  });

  it("says plainly when a PDF has no text to read", async () => {
    const prepared = await prepareAttachments(userId, [await attach("scan.pdf", makePdf([""]))]);
    expect(prepared.text).toBe('[Attached PDF "scan.pdf" has no text layer (its pages are probably scanned images), so its contents could not be read.]');
  });
});
