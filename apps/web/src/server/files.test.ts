import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@aiw/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTextFile, MAX_TEXT_BYTES, previewFor, readTextFile, searchFiles } from "./files";

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aiw-files-"));
  workspace = Workspace.forUser(root, "user");
  await mkdir(workspace.root, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("file search (spec §24)", () => {
  it("finds files by name anywhere in the workspace, ignoring case and hidden folders", async () => {
    await mkdir(path.join(workspace.root, "docs/deep"), { recursive: true });
    await mkdir(path.join(workspace.root, "node_modules/pkg"), { recursive: true });
    await mkdir(path.join(workspace.root, ".git"), { recursive: true });
    await writeFile(path.join(workspace.root, "README.md"), "top");
    await writeFile(path.join(workspace.root, "docs/deep/readme-notes.txt"), "deep");
    await writeFile(path.join(workspace.root, "node_modules/pkg/README.md"), "dependency");
    await writeFile(path.join(workspace.root, ".git/README"), "hidden");

    const { entries, truncated } = await searchFiles(workspace, "readme");
    expect(truncated).toBe(false);
    expect(entries.map((e) => e.path).sort()).toEqual(["README.md", "docs/deep/readme-notes.txt"]);
    expect(entries.find((e) => e.path === "README.md")).toMatchObject({ kind: "file", size: 3 });
  });

  it("returns nothing for a name that is not there", async () => {
    await writeFile(path.join(workspace.root, "a.txt"), "a");
    expect((await searchFiles(workspace, "zzz")).entries).toEqual([]);
  });
});

describe("file create (spec §24)", () => {
  it("creates a text file, making folders as needed, and never overwrites", async () => {
    const entry = await createTextFile(workspace, "notes/todo.md", "- first\n");
    expect(entry).toMatchObject({ name: "todo.md", path: "notes/todo.md", kind: "file", size: 8 });

    await expect(createTextFile(workspace, "notes/todo.md", "replaced")).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a path outside the workspace", async () => {
    await expect(createTextFile(workspace, "../escape.txt", "x")).rejects.toThrow();
  });
});

describe("file preview kinds (spec §24)", () => {
  it("classifies each viewable type from its extension, case-insensitively", () => {
    expect(previewFor("photo.PNG")).toEqual({ mediaType: "image/png", kind: "image" });
    expect(previewFor("a/b/scan.pdf")).toEqual({ mediaType: "application/pdf", kind: "pdf" });
    expect(previewFor("track.mp3")).toEqual({ mediaType: "audio/mpeg", kind: "audio" });
    expect(previewFor("clip.webm")).toEqual({ mediaType: "video/webm", kind: "video" });
    expect(previewFor("logo.svg")).toEqual({ mediaType: "image/svg+xml", kind: "image" });
  });

  it("refuses types the browser would execute, so a workspace file cannot become stored XSS", () => {
    // These are all served as downloads instead; the viewer shows their source
    // as text, which is why nothing is lost by keeping them out.
    for (const name of ["page.html", "page.htm", "doc.xhtml", "app.js", "data.xml", "sheet.xsl"]) {
      expect(previewFor(name)).toBeNull();
    }
  });

  it("refuses anything not on the allowlist rather than guessing a type", () => {
    expect(previewFor("archive.zip")).toBeNull();
    expect(previewFor("notes.md")).toBeNull();
    expect(previewFor("noextension")).toBeNull();
    expect(previewFor("trick.png.exe")).toBeNull();
  });

  it("describes a binary it can show without reading it as text", async () => {
    // A PNG header followed by a NUL byte: text reading would call it binary.
    await writeFile(path.join(workspace.root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const result = await readTextFile(workspace, "pic.png");
    expect(result).toMatchObject({ kind: "image", mediaType: "image/png", text: null, reason: null });
  });

  it("still reads a text file as text", async () => {
    await writeFile(path.join(workspace.root, "notes.md"), "# hello\n");
    expect(await readTextFile(workspace, "notes.md")).toMatchObject({ kind: "text", text: "# hello\n", mediaType: "text/plain" });
  });

  it("says why an unviewable binary cannot be shown instead of showing nothing", async () => {
    await writeFile(path.join(workspace.root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
    const result = await readTextFile(workspace, "blob.bin");
    expect(result.kind).toBe("none");
    expect(result.text).toBeNull();
    expect(result.reason).toMatch(/Download it/);
  });

  it("does not apply the text size cap to a previewable binary", async () => {
    // A 600KB image is past MAX_TEXT_BYTES but perfectly fine for an <img>.
    await writeFile(path.join(workspace.root, "big.jpg"), Buffer.alloc(MAX_TEXT_BYTES + 1024, 1));
    expect(await readTextFile(workspace, "big.jpg")).toMatchObject({ kind: "image", truncated: false });

    await writeFile(path.join(workspace.root, "big.log"), "x".repeat(MAX_TEXT_BYTES + 1));
    expect(await readTextFile(workspace, "big.log")).toMatchObject({ kind: "none", truncated: true });
  });
});
