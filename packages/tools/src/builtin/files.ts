import { mkdir, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolError, type AnyToolDefinition, type ToolContext } from "../types";
import type { Workspace } from "../workspace";

const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".turbo"]);
const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_CHARS = 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const available = () => ({ available: true });

const relativePath = z.string().trim().min(1).max(1024).describe("Path relative to the workspace root, e.g. src/index.ts");

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

async function walk(
  workspace: Workspace,
  start: string,
  options: { maxDepth: number; limit: number },
  visit: (absolute: string, type: "file" | "directory", depth: number) => Promise<boolean | void>,
): Promise<boolean> {
  const queue: { dir: string; depth: number }[] = [{ dir: start, depth: 1 }];
  let count = 0;
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    const handle = await opendir(dir);
    const entries = [];
    for await (const entry of handle) entries.push(entry);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (!workspace.contains(absolute)) continue;
      const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null;
      if (!type) continue;
      if (++count > options.limit) return true;
      if ((await visit(absolute, type, depth)) === false) return true;
      if (type === "directory" && depth < options.maxDepth && !SKIP_DIRECTORIES.has(entry.name)) {
        queue.push({ dir: absolute, depth: depth + 1 });
      }
    }
  }
  return false;
}

async function readTextFile(absolute: string, context: ToolContext): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const info = await stat(absolute);
  if (info.isDirectory()) throw new ToolError("invalid_input", "That path is a directory. Use files.list instead.");
  const buffer = await readFile(absolute);
  if (isBinary(buffer)) throw new ToolError("invalid_input", "The file appears to be binary and cannot be read as text.");
  const truncated = buffer.length > MAX_READ_BYTES;
  const text = buffer.subarray(0, MAX_READ_BYTES).toString("utf8");
  context.report({ type: "FILE_READ", path: context.workspace.relative(absolute), bytes: buffer.length });
  return { text, bytes: buffer.length, truncated };
}

const listTool = {
  name: "files.list",
  description: "List files and directories in the workspace. Skips .git, node_modules and build output.",
  category: "files",
  permission: "READ",
  timeoutMs: 15_000,
  inputSchema: z.object({
    path: z.string().trim().max(1024).default(".").describe("Directory relative to the workspace root"),
    recursive: z.boolean().default(false),
    maxDepth: z.number().int().min(1).max(5).default(3),
  }),
  availability: available,
  async execute(input, context) {
    const dir = await context.workspace.resolve(input.path, { mustExist: true });
    if (!(await stat(dir)).isDirectory()) throw new ToolError("invalid_input", "That path is a file, not a directory.");
    const entries: { path: string; type: "file" | "directory"; size: number | null }[] = [];
    const truncated = await walk(context.workspace, dir, { maxDepth: input.recursive ? input.maxDepth : 1, limit: 500 }, async (absolute, type) => {
      entries.push({ path: context.workspace.relative(absolute), type, size: type === "file" ? (await stat(absolute)).size : null });
    });
    const lines = entries.map((e) => (e.type === "directory" ? `${e.path}/` : `${e.path} (${e.size} bytes)`));
    return {
      output: { path: context.workspace.relative(dir), entries, truncated },
      summary: `Listed ${entries.length} entr${entries.length === 1 ? "y" : "ies"} in ${context.workspace.relative(dir)}`,
      content: lines.length ? `${lines.join("\n")}${truncated ? "\n… (truncated at 500 entries)" : ""}` : "(empty directory)",
    };
  },
} satisfies AnyToolDefinition;

const readTool = {
  name: "files.read",
  description: "Read a UTF-8 text file from the workspace, optionally a line range.",
  category: "files",
  permission: "READ",
  timeoutMs: 15_000,
  inputSchema: z.object({
    path: relativePath,
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  }),
  availability: available,
  async execute(input, context) {
    const absolute = await context.workspace.resolve(input.path, { mustExist: true });
    const { text, bytes, truncated } = await readTextFile(absolute, context);
    const lines = text.split(/\r?\n/);
    const start = input.startLine ?? 1;
    const end = Math.min(input.endLine ?? lines.length, lines.length);
    const selected = lines.slice(start - 1, end).join("\n");
    const rel = context.workspace.relative(absolute);
    return {
      output: { path: rel, bytes, lines: lines.length, startLine: start, endLine: end, truncated, content: selected },
      summary: `Read ${rel} (${bytes} bytes)`,
      content: `File ${rel}, lines ${start}-${end} of ${lines.length}${truncated ? " (file truncated to 256 KB)" : ""}:\n${selected}`,
    };
  },
} satisfies AnyToolDefinition;

const writeTool = {
  name: "files.write",
  description: "Create a file or replace its entire contents. Parent directories are created as needed.",
  category: "files",
  permission: "WRITE",
  timeoutMs: 15_000,
  inputSchema: z.object({
    path: relativePath,
    content: z.string().max(MAX_WRITE_CHARS),
  }),
  availability: available,
  async execute(input, context) {
    const absolute = await context.workspace.resolve(input.path);
    const existed = await stat(absolute).then(
      (s) => {
        if (s.isDirectory()) throw new ToolError("invalid_input", "That path is a directory.");
        return true;
      },
      () => false,
    );
    await mkdir(path.dirname(absolute), { recursive: true });
    await context.workspace.resolve(input.path); // re-check after creating parents
    await writeFile(absolute, input.content, "utf8");
    const bytes = Buffer.byteLength(input.content);
    const rel = context.workspace.relative(absolute);
    context.report({ type: existed ? "FILE_UPDATED" : "FILE_CREATED", path: rel, bytes });
    return {
      output: { path: rel, bytes, created: !existed },
      summary: `${existed ? "Updated" : "Created"} ${rel} (${bytes} bytes)`,
    };
  },
} satisfies AnyToolDefinition;

const editTool = {
  name: "files.edit",
  description: "Replace exact text in a file. oldText must match exactly once unless replaceAll is true.",
  category: "files",
  permission: "WRITE",
  timeoutMs: 15_000,
  inputSchema: z.object({
    path: relativePath,
    oldText: z.string().min(1).max(100_000),
    newText: z.string().max(MAX_WRITE_CHARS),
    replaceAll: z.boolean().default(false),
  }),
  availability: available,
  async execute(input, context) {
    const absolute = await context.workspace.resolve(input.path, { mustExist: true });
    const { text, truncated } = await readTextFile(absolute, context);
    if (truncated) throw new ToolError("invalid_input", "The file is too large to edit safely (over 256 KB).");
    const occurrences = text.split(input.oldText).length - 1;
    if (occurrences === 0) throw new ToolError("not_found", "oldText was not found in the file. Read the file and copy the exact text.");
    if (occurrences > 1 && !input.replaceAll) {
      throw new ToolError("invalid_input", `oldText matches ${occurrences} times. Include more surrounding text or set replaceAll.`);
    }
    const updated = input.replaceAll ? text.split(input.oldText).join(input.newText) : text.replace(input.oldText, () => input.newText);
    await writeFile(absolute, updated, "utf8");
    const rel = context.workspace.relative(absolute);
    const bytes = Buffer.byteLength(updated);
    context.report({ type: "FILE_UPDATED", path: rel, bytes });
    const replacements = input.replaceAll ? occurrences : 1;
    return { output: { path: rel, replacements, bytes }, summary: `Edited ${rel} (${replacements} replacement${replacements === 1 ? "" : "s"})` };
  },
} satisfies AnyToolDefinition;

const searchTool = {
  name: "files.search",
  description: "Search text files in the workspace for a literal string. Returns matching lines.",
  category: "files",
  permission: "READ",
  timeoutMs: 30_000,
  inputSchema: z.object({
    query: z.string().min(1).max(200),
    path: z.string().trim().max(1024).default("."),
    caseSensitive: z.boolean().default(false),
    maxResults: z.number().int().min(1).max(200).default(50),
  }),
  availability: available,
  async execute(input, context) {
    const start = await context.workspace.resolve(input.path, { mustExist: true });
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
    const matches: { path: string; line: number; text: string }[] = [];
    let filesScanned = 0;
    await walk(context.workspace, start, { maxDepth: 12, limit: 5000 }, async (absolute, type) => {
      if (context.signal.aborted) return false;
      if (type !== "file") return;
      const info = await stat(absolute);
      if (info.size > MAX_SEARCH_FILE_BYTES) return;
      const buffer = await readFile(absolute);
      if (isBinary(buffer)) return;
      filesScanned++;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if ((input.caseSensitive ? line : line.toLowerCase()).includes(needle)) {
          matches.push({ path: context.workspace.relative(absolute), line: index + 1, text: line.trim().slice(0, 240) });
          if (matches.length >= input.maxResults) return false;
        }
      }
    });
    return {
      output: { query: input.query, matches, filesScanned },
      summary: `Found ${matches.length} match${matches.length === 1 ? "" : "es"} for "${input.query}"`,
      content: matches.length ? matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") : "No matches.",
    };
  },
} satisfies AnyToolDefinition;

const deleteTool = {
  name: "files.delete",
  description: "Delete a single file from the workspace. DESTRUCTIVE: requires human approval.",
  category: "files",
  permission: "DESTRUCTIVE",
  timeoutMs: 15_000,
  inputSchema: z.object({ path: relativePath }),
  availability: available,
  async execute(input, context) {
    const absolute = await context.workspace.resolve(input.path, { mustExist: true });
    if ((await stat(absolute)).isDirectory()) throw new ToolError("invalid_input", "Only files can be deleted.");
    await rm(absolute);
    const rel = context.workspace.relative(absolute);
    return { output: { path: rel, deleted: true }, summary: `Deleted ${rel}` };
  },
} satisfies AnyToolDefinition;

export function createFileTools(): AnyToolDefinition[] {
  return [listTool, readTool, searchTool, writeTool, editTool, deleteTool];
}
