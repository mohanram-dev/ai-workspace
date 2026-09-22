import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDatabase, getProjectForUser } from "@aiw/database";
import { projectWorkspace } from "@aiw/agents";
import { isToolError, type Workspace } from "@aiw/tools";
import type { FileContentDto, FileEntryDto, FileListDto } from "@aiw/shared";
import { HttpError } from "./http";
import { getWorkspaceRoot } from "./tools";

/** Largest file shown as text in the browser. */
export const MAX_TEXT_BYTES = 512 * 1024;
/** Largest upload accepted. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SKIPPED = new Set([".git", "node_modules", ".next", "dist", "build"]);

/**
 * Extensions the viewer can render, and the media type each is served with.
 *
 * This is an allowlist rather than a lookup of every known type, because these
 * bytes are user-supplied and served from the app's own origin: a type the
 * browser will execute (`text/html`, `application/xhtml+xml`) would be stored
 * XSS against the session. Anything absent is downloaded as
 * `application/octet-stream` instead, and text files are shown as text, so an
 * HTML file is still readable — as source.
 *
 * SVG is here because the viewer only ever puts it in an `<img>`, where a
 * browser does not run its scripts; the raw route additionally sends
 * `Content-Security-Policy: sandbox` so opening the URL directly is inert too.
 */
const PREVIEWABLE: Record<string, { mediaType: string; kind: PreviewKind }> = {
  ".png": { mediaType: "image/png", kind: "image" },
  ".jpg": { mediaType: "image/jpeg", kind: "image" },
  ".jpeg": { mediaType: "image/jpeg", kind: "image" },
  ".gif": { mediaType: "image/gif", kind: "image" },
  ".webp": { mediaType: "image/webp", kind: "image" },
  ".avif": { mediaType: "image/avif", kind: "image" },
  ".bmp": { mediaType: "image/bmp", kind: "image" },
  ".ico": { mediaType: "image/x-icon", kind: "image" },
  ".svg": { mediaType: "image/svg+xml", kind: "image" },
  ".pdf": { mediaType: "application/pdf", kind: "pdf" },
  ".mp3": { mediaType: "audio/mpeg", kind: "audio" },
  ".wav": { mediaType: "audio/wav", kind: "audio" },
  ".ogg": { mediaType: "audio/ogg", kind: "audio" },
  ".oga": { mediaType: "audio/ogg", kind: "audio" },
  ".m4a": { mediaType: "audio/mp4", kind: "audio" },
  ".flac": { mediaType: "audio/flac", kind: "audio" },
  ".mp4": { mediaType: "video/mp4", kind: "video" },
  ".m4v": { mediaType: "video/mp4", kind: "video" },
  ".webm": { mediaType: "video/webm", kind: "video" },
  ".ogv": { mediaType: "video/ogg", kind: "video" },
  ".mov": { mediaType: "video/quicktime", kind: "video" },
};

export type PreviewKind = FileContentDto["kind"];

/** How a file should be previewed, from its extension alone. */
export function previewFor(name: string): { mediaType: string; kind: PreviewKind } | null {
  return PREVIEWABLE[path.extname(name).toLowerCase()] ?? null;
}

/** The workspace a request addresses: the user's own, or one of their projects. */
export async function resolveWorkspace(userId: string, projectId: string | null | undefined): Promise<{ workspace: Workspace; info: FileListDto["workspace"] }> {
  const root = getWorkspaceRoot();
  if (!projectId) {
    return { workspace: projectWorkspace(root, userId, null), info: { kind: "personal", id: null, name: "Personal workspace" } };
  }
  const project = await getProjectForUser(getDatabase(), userId, projectId);
  if (!project) throw new HttpError(404, "not_found", "Project not found.");
  return { workspace: projectWorkspace(root, userId, project.id), info: { kind: "project", id: project.id, name: project.name } };
}

/** Turns a ToolError from the workspace guard into the right HTTP error. */
export function toHttpError(error: unknown): never {
  if (isToolError(error)) {
    const status = error.code === "not_found" ? 404 : error.code === "permission_denied" || error.code === "invalid_input" ? 400 : 500;
    throw new HttpError(status, status === 404 ? "not_found" : "bad_request", error.message);
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new HttpError(404, "not_found", "That file or folder does not exist.");
  throw error;
}

export async function listDirectory(workspace: Workspace, requested: string): Promise<{ path: string; entries: FileEntryDto[]; parent: string | null }> {
  const absolute = await workspace.resolve(requested, { mustExist: true });
  const stats = await stat(absolute);
  if (!stats.isDirectory()) throw new HttpError(400, "bad_request", "That path is a file, not a folder.");

  const names = await readdir(absolute, { withFileTypes: true });
  const entries: FileEntryDto[] = [];
  for (const entry of names) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    if (SKIPPED.has(entry.name)) continue;
    const child = path.join(absolute, entry.name);
    const childStats = await stat(child).catch(() => null);
    if (!childStats) continue;
    entries.push({
      name: entry.name,
      path: workspace.relative(child),
      kind: childStats.isDirectory() ? "directory" : "file",
      size: childStats.isDirectory() ? 0 : childStats.size,
      modifiedAt: childStats.mtime.toISOString(),
    });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));

  const relative = workspace.relative(absolute);
  const parent = relative === "." ? null : workspace.relative(path.dirname(absolute));
  return { path: relative, entries, parent };
}

const BINARY_PATTERN = /\0/;

export async function readTextFile(workspace: Workspace, requested: string): Promise<FileContentDto> {
  const absolute = await workspace.resolve(requested, { mustExist: true });
  const stats = await stat(absolute);
  if (stats.isDirectory()) throw new HttpError(400, "bad_request", "That path is a folder, not a file.");
  const base = { path: workspace.relative(absolute), size: stats.size, modifiedAt: stats.mtime.toISOString() };

  // An image, PDF, sound or video is described here and fetched as bytes from
  // the raw route; its size is the browser's problem, not MAX_TEXT_BYTES'.
  const preview = previewFor(absolute);
  if (preview) {
    return { ...base, text: null, truncated: false, reason: null, kind: preview.kind, mediaType: preview.mediaType };
  }

  if (stats.size > MAX_TEXT_BYTES) {
    return {
      ...base,
      text: null,
      truncated: true,
      reason: "The file is too large to show here. Download it instead.",
      kind: "none",
      mediaType: null,
    };
  }
  const buffer = await readFile(absolute);
  const text = buffer.toString("utf8");
  if (BINARY_PATTERN.test(text.slice(0, 4000))) {
    return {
      ...base,
      text: null,
      truncated: false,
      reason: "This file is not text, and its type has no viewer here. Download it to open it.",
      kind: "none",
      mediaType: null,
    };
  }
  return { ...base, text, truncated: false, reason: null, kind: "text", mediaType: "text/plain" };
}

export async function readFileBytes(workspace: Workspace, requested: string) {
  const absolute = await workspace.resolve(requested, { mustExist: true });
  const stats = await stat(absolute);
  if (stats.isDirectory()) throw new HttpError(400, "bad_request", "That path is a folder, not a file.");
  return { bytes: await readFile(absolute), name: path.basename(absolute), size: stats.size };
}

/** Files visited by one search; enough for a project, small enough to stay quick. */
const SEARCH_MAX_VISITED = 5_000;
const SEARCH_MAX_RESULTS = 200;

/**
 * Finds files whose name contains the query (case-insensitive) anywhere under
 * the workspace (spec §24). Walks the real directory tree, skipping the same
 * hidden and dependency folders the listing does, and stops at a fixed budget
 * so a huge workspace cannot tie the request up.
 */
export async function searchFiles(workspace: Workspace, query: string): Promise<{ entries: FileEntryDto[]; truncated: boolean }> {
  const needle = query.trim().toLowerCase();
  const entries: FileEntryDto[] = [];
  let visited = 0;
  let truncated = false;
  const pending = [await workspace.resolve(".", { mustExist: true })];

  while (pending.length > 0 && !truncated) {
    const directory = pending.shift()!;
    const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of names) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (SKIPPED.has(entry.name)) continue;
      if (++visited > SEARCH_MAX_VISITED || entries.length >= SEARCH_MAX_RESULTS) {
        truncated = true;
        break;
      }
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      if (!entry.name.toLowerCase().includes(needle)) continue;
      const stats = await stat(child).catch(() => null);
      if (!stats) continue;
      entries.push({ name: entry.name, path: workspace.relative(child), kind: "file", size: stats.size, modifiedAt: stats.mtime.toISOString() });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, truncated };
}

/** Creates a new text file; refuses to overwrite, because "create" must never mean "replace". */
export async function createTextFile(workspace: Workspace, requested: string, content: string): Promise<FileEntryDto> {
  const absolute = await workspace.resolve(requested);
  await mkdir(path.dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "conflict", "A file with that name already exists.");
    throw error;
  }
  const stats = await stat(absolute);
  return { name: path.basename(absolute), path: workspace.relative(absolute), kind: "file", size: stats.size, modifiedAt: stats.mtime.toISOString() };
}
