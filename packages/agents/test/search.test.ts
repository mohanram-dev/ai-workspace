import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProviderRegistry, type EmbedRequest, type ModelProvider } from "@aiw/ai";
import { type DatabaseHandle } from "@aiw/database";
import { Workspace } from "@aiw/tools";
import { makePdf } from "@aiw/tools/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chunkText, semanticSearch } from "../src";
import { createUser, openTestDatabase } from "./helpers";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";

/** Words hashed into 64 buckets: texts sharing words point the same way, so ranking is deterministic. */
class WordEmbedder implements ModelProvider {
  readonly id = "fake";
  readonly name = "Fake";
  readonly defaultModel = "fake-chat";
  calls: EmbedRequest[] = [];
  isConfigured() {
    return true;
  }
  async listModels() {
    return [];
  }
  async *streamChat(): AsyncGenerator<never> {}
  async embed(request: EmbedRequest) {
    this.calls.push(request);
    return request.texts.map((text) => {
      const vector = new Array<number>(64).fill(0);
      for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        let h = 0;
        for (const c of word) h = (h * 31 + c.charCodeAt(0)) % 64;
        vector[h]! += 1;
      }
      return vector;
    });
  }
  embeddedTexts() {
    return this.calls.filter((c) => c.purpose === "document").reduce((n, c) => n + c.texts.length, 0);
  }
}

let handle: DatabaseHandle;
let base: string;
beforeAll(async () => {
  handle = openTestDatabase();
  base = await mkdtemp(path.join(os.tmpdir(), "aiw-search-"));
});
afterAll(async () => {
  await handle.close();
  await rm(base, { recursive: true, force: true });
});

async function setup() {
  const userId = await createUser(handle);
  const workspace = new Workspace(path.join(base, userId));
  await workspace.ensure();
  const embedder = new WordEmbedder();
  const config = { db: handle.db, registry: new ProviderRegistry([embedder], "fake"), provider: "fake", model: "fake-embed" };
  const write = async (rel: string, content: string | Buffer) => {
    await mkdir(path.dirname(path.join(workspace.root, rel)), { recursive: true });
    await writeFile(path.join(workspace.root, rel), content);
  };
  const search = (query: string, extra: { path?: string } = {}) =>
    semanticSearch(config, { userId, projectId: null, workspace, query, maxResults: 3, signal: new AbortController().signal, ...extra });
  return { workspace, embedder, write, search };
}

describe("chunkText", () => {
  it("keeps whole lines and records where each chunk sits", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkText(text);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 40 });
    expect(chunks[1]).toMatchObject({ startLine: 41, endLine: 80 });
    expect(chunks.at(-1)).toMatchObject({ endLine: 100 });
    expect(chunks.at(-1)!.content.endsWith("line 100")).toBe(true);
  });
});

describe("semanticSearch", () => {
  it("finds the passage by meaning-bearing words, PDFs included, and skips binaries", async () => {
    const { write, search } = await setup();
    await write("billing/refunds.md", "Refunds are issued within five days when a customer asks for their money back.");
    await write("docs/deploy.md", "Deploy with docker compose up on the production server.");
    await write("contracts/terms.pdf", makePdf(["Termination requires thirty days written notice"]));
    await write("image.bin", Buffer.from([0, 1, 2, 3, 0, 5]));

    const refunds = await search("how do customers get their money back");
    expect(refunds.hits[0]).toMatchObject({ path: "billing/refunds.md", startLine: 1 });
    expect(refunds.indexedFiles).toBe(3);

    const notice = await search("termination notice days");
    expect(notice.hits[0]?.path).toBe("contracts/terms.pdf");
  });

  it("re-embeds only what changed, and forgets deleted files", async () => {
    const { workspace, embedder, write, search } = await setup();
    await write("a.md", "alpha apples");
    await write("b.md", "beta bananas");
    await search("apples");
    expect(embedder.embeddedTexts()).toBe(2);

    await search("bananas");
    expect(embedder.embeddedTexts()).toBe(2);

    await write("a.md", "alpha apricots now");
    await utimes(path.join(workspace.root, "a.md"), new Date(), new Date(Date.now() + 5_000));
    await rm(path.join(workspace.root, "b.md"));
    const after = await search("apricots");
    expect(embedder.embeddedTexts()).toBe(3);
    expect(after.indexedFiles).toBe(1);
    expect(after.hits.map((h) => h.path)).toEqual(["a.md"]);
  });

  it("searches only under a folder when asked", async () => {
    const { write, search } = await setup();
    await write("notes/plan.md", "launch plan for the release");
    await write("archive/plan.md", "launch plan for the release");
    const scoped = await search("launch plan", { path: "notes" });
    expect(scoped.hits.map((h) => h.path)).toEqual(["notes/plan.md"]);
  });

  it("carries files beyond one search's budget over to the next search", async () => {
    const { write, search } = await setup();
    // Each file is ~500 chunks (one per 40 lines); the per-search budget is 600.
    const big = Array.from({ length: 20_000 }, (_, i) => `row ${i} of the ledger`).join("\n");
    await write("ledger1.txt", big);
    await write("ledger2.txt", big);
    const first = await search("ledger");
    expect(first.pendingFiles).toBe(1);
    const second = await search("ledger");
    expect(second.pendingFiles).toBe(0);
    expect(second.indexedFiles).toBe(2);
  }, 60_000);
});
