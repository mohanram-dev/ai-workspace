import { readFile, stat } from "node:fs/promises";
import type { ProviderRegistry } from "@aiw/ai";
import { deleteFileChunks, getTask, listChunksForSearch, listIndexedFiles, replaceFileChunks, type Database } from "@aiw/database";
import { extractPdfText, isPdf, MAX_PDF_BYTES, ToolError, walkWorkspace, type AnyToolDefinition, type Workspace } from "@aiw/tools";
import { z } from "zod";

export interface SemanticSearchConfig {
  db: Database;
  registry: ProviderRegistry;
  /** Provider that embeds, and its embedding model. Null switches semantic search off. */
  provider: string | null;
  model: string;
}

/** Files looked at per workspace. */
const MAX_FILES = 2_000;
/** Chunks kept per workspace: every search compares the query with all of them. */
const MAX_CHUNKS = 8_000;
/** New chunks embedded per search, so a big first index is built over a few searches instead of stalling one. */
const MAX_NEW_CHUNKS_PER_CALL = 600;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const CHUNK_CHARS = 1_500;
const CHUNK_MAX_LINES = 40;

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  indexedFiles: number;
  /** Files still waiting to be embedded; a later search continues. */
  pendingFiles: number;
  newlyEmbedded: number;
}

/** Lines grouped into chunks of about CHUNK_CHARS, never splitting a line. */
export function chunkText(text: string): { startLine: number; endLine: number; content: string }[] {
  const lines = text.split(/\r?\n/);
  const chunks: { startLine: number; endLine: number; content: string }[] = [];
  let start = 0;
  let buffer: string[] = [];
  let size = 0;
  const flush = (end: number) => {
    const content = buffer.join("\n").trim();
    if (content) chunks.push({ startLine: start + 1, endLine: end, content: content.slice(0, CHUNK_CHARS * 2) });
    buffer = [];
    size = 0;
  };
  lines.forEach((line, index) => {
    if (buffer.length === 0) start = index;
    buffer.push(line);
    size += line.length + 1;
    if (size >= CHUNK_CHARS || buffer.length >= CHUNK_MAX_LINES) flush(index + 1);
  });
  if (buffer.length) flush(lines.length);
  return chunks;
}

function toBytes(vector: number[]): Buffer {
  const floats = new Float32Array(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function toVector(bytes: Buffer): Float32Array {
  // A copy, because a Buffer may start at an offset Float32Array cannot use.
  return new Float32Array(new Uint8Array(bytes).buffer);
}

function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The text a file offers for search: its content, a PDF's text layer, or nothing for binaries. */
async function searchableText(absolute: string, size: number): Promise<string | null> {
  const bytes = await readFile(absolute);
  if (isPdf(bytes)) {
    if (size > MAX_PDF_BYTES) return null;
    const pdf = await extractPdfText(bytes).catch(() => null);
    return pdf?.hasText ? pdf.text : null;
  }
  if (size > MAX_TEXT_FILE_BYTES || bytes.subarray(0, 8000).includes(0)) return null;
  return bytes.toString("utf8");
}

/**
 * Brings a workspace's index up to date — within a budget — and ranks its
 * chunks against the query. Changed files are re-embedded, deleted ones
 * dropped; files beyond the budget wait for the next search and are counted.
 */
export async function semanticSearch(
  config: SemanticSearchConfig,
  input: { userId: string; projectId: string | null; workspace: Workspace; query: string; path?: string; maxResults: number; signal: AbortSignal },
): Promise<SearchOutcome> {
  if (!config.provider) throw new ToolError("unavailable", "Semantic search is off (EMBEDDING_PROVIDER=none).");
  const provider = config.registry.get(config.provider);
  if (!provider?.embed || !provider.isConfigured()) {
    throw new ToolError("unavailable", `${provider?.name ?? config.provider} cannot embed text here: set EMBEDDING_PROVIDER to a configured provider.`);
  }
  const embed = (texts: string[], purpose: "document" | "query") =>
    provider.embed!({ model: config.model, texts, purpose, signal: input.signal }).catch((error: unknown) => {
      throw new ToolError("failed", `Embedding with ${config.model} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    });

  const { db } = config;
  const key = input.projectId ?? "personal";
  const indexed = new Map((await listIndexedFiles(db, input.userId, key)).map((f) => [f.path, f]));

  // What is on disk now.
  const files: { path: string; absolute: string; mtimeMs: number; size: number }[] = [];
  await walkWorkspace(input.workspace, input.workspace.root, { maxDepth: 12, limit: MAX_FILES * 4 }, async (absolute, type) => {
    if (input.signal.aborted) return false;
    if (type !== "file" || files.length >= MAX_FILES) return;
    const info = await stat(absolute);
    files.push({ path: input.workspace.relative(absolute), absolute, mtimeMs: info.mtimeMs, size: info.size });
  });

  const present = new Set(files.map((f) => f.path));
  await deleteFileChunks(db, input.userId, key, [...indexed.keys()].filter((p) => !present.has(p)));

  let budget = MAX_NEW_CHUNKS_PER_CALL;
  let pendingFiles = 0;
  let newlyEmbedded = 0;
  let totalChunks = 0;
  for (const file of files) {
    const known = indexed.get(file.path);
    if (known && known.fileMtimeMs === file.mtimeMs && known.fileSize === file.size && known.model === config.model) continue;
    if (budget <= 0 || totalChunks >= MAX_CHUNKS) {
      pendingFiles++;
      continue;
    }
    const text = await searchableText(file.absolute, file.size).catch(() => null);
    const all = text ? chunkText(text) : [];
    // A file that does not fit what is left waits for the next search whole,
    // rather than being stored half-indexed as if complete. Only a file larger
    // than an entire budget (~900 KB of text) is cut to its first part.
    if (all.length > budget && newlyEmbedded > 0) {
      pendingFiles++;
      continue;
    }
    const chunks = all.slice(0, budget);
    // The path goes in with the text: "the invoice script" should find invoices/generate.py.
    const vectors = chunks.length ? await embed(chunks.map((c) => `${file.path}\n${c.content}`), "document") : [];
    await replaceFileChunks(
      db,
      input.userId,
      key,
      file.path,
      chunks.map((chunk, index) => ({
        chunkIndex: index,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        fileMtimeMs: file.mtimeMs,
        fileSize: file.size,
        model: config.model,
        embedding: toBytes(vectors[index] ?? []),
      })),
    );
    budget -= chunks.length;
    newlyEmbedded += chunks.length;
    totalChunks += chunks.length;
  }

  const [queryVector] = await embed([input.query], "query");
  const query = new Float32Array(queryVector ?? []);
  const prefix = input.path && input.path !== "." ? `${input.path.replace(/\\/g, "/").replace(/\/+$/, "")}/` : undefined;
  const rows = await listChunksForSearch(db, input.userId, key, config.model, prefix);
  const hits = rows
    .map((row) => ({ row, score: cosine(query, toVector(row.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, input.maxResults)
    .map(({ row, score }) => ({
      path: row.path,
      startLine: row.startLine,
      endLine: row.endLine,
      score: Math.round(score * 1000) / 1000,
      snippet: row.content.length > 700 ? `${row.content.slice(0, 700)}…` : row.content,
    }));
  const indexedFiles = new Set(rows.map((r) => r.path)).size;
  return { hits, indexedFiles, pendingFiles, newlyEmbedded };
}

/** files.semantic_search: find passages by meaning, not exact words (the counterpart of files.search). */
export function createSearchTools(config: SemanticSearchConfig): AnyToolDefinition[] {
  const tool = {
    name: "files.semantic_search",
    description:
      "Search the workspace's text files and PDFs by meaning, for questions like \"where do we handle refunds?\" when the exact words are unknown. " +
      "Returns the best-matching passages with file paths and line numbers; read the file for the full context. Use files.search for an exact string.",
    category: "files",
    permission: "READ",
    // A first search may embed hundreds of chunks.
    timeoutMs: 180_000,
    inputSchema: z.object({
      query: z.string().trim().min(2).max(500),
      path: z.string().trim().max(1024).default(".").describe("Only search under this folder"),
      maxResults: z.number().int().min(1).max(20).default(8),
    }),
    availability: () => {
      if (!config.provider) return { available: false, reason: "Semantic search is off (EMBEDDING_PROVIDER=none)." };
      const provider = config.registry.get(config.provider);
      return provider?.embed && provider.isConfigured()
        ? { available: true }
        : { available: false, reason: `The embedding provider "${config.provider}" is not configured.` };
    },
    async execute(input: { query: string; path: string; maxResults: number }, context) {
      if (input.path !== ".") await context.workspace.resolve(input.path, { mustExist: true });
      const task = await getTask(config.db, context.taskId);
      const outcome = await semanticSearch(config, {
        userId: context.userId,
        projectId: task?.projectId ?? null,
        workspace: context.workspace,
        query: input.query,
        path: input.path,
        maxResults: input.maxResults,
        signal: context.signal,
      });
      const coverage =
        outcome.pendingFiles > 0
          ? `Index incomplete: ${outcome.pendingFiles} file(s) not embedded yet; searching again continues. `
          : "";
      return {
        output: outcome,
        summary: `Searched "${input.query}" by meaning: ${outcome.hits.length} passage(s)${outcome.newlyEmbedded ? `, ${outcome.newlyEmbedded} chunk(s) newly indexed` : ""}`,
        content: [
          `${coverage}${outcome.indexedFiles} file(s) indexed.`,
          ...outcome.hits.map((h, i) => `${i + 1}. ${h.path}:${h.startLine}-${h.endLine} (score ${h.score})\n${h.snippet}`),
          outcome.hits.length === 0 ? "No matching passages." : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    },
  } satisfies AnyToolDefinition;
  return [tool];
}

export const SEARCH_TOOL_NAMES = ["files.semantic_search"] as const;
