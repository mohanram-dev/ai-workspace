import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@aiw/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTextFile, searchFiles } from "./files";

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
