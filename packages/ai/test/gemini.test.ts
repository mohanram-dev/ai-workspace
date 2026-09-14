import { ApiError, type GenerateContentParameters, type GenerateContentResponse, type Model } from "@google/genai";
import { describe, expect, it } from "vitest";
import { completeChat, GeminiProvider, ProviderError, toGeminiContents, type ChatStreamChunk, type GeminiClient } from "../src";

type ChunkInit = Partial<GenerateContentResponse>;

function stubClient(options: {
  chunks?: ChunkInit[];
  failWith?: unknown;
  failAfter?: number;
  models?: Partial<Model>[];
  onRequest?: (params: GenerateContentParameters) => void;
}): GeminiClient {
  return {
    models: {
      async generateContentStream(params) {
        options.onRequest?.(params);
        if (options.failWith && options.failAfter === undefined) throw options.failWith;
        async function* generate() {
          let index = 0;
          for (const chunk of options.chunks ?? []) {
            if (options.failAfter !== undefined && index === options.failAfter) throw options.failWith;
            index++;
            yield chunk as GenerateContentResponse;
          }
        }
        return generate();
      },
      async list() {
        async function* generate() {
          for (const model of options.models ?? []) yield model as Model;
        }
        return generate();
      },
    },
  };
}

function textChunk(text: string, extra: ChunkInit = {}): ChunkInit {
  return { candidates: [{ content: { role: "model", parts: [{ text }] } }], ...extra };
}

async function collect(stream: AsyncIterable<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("toGeminiContents", () => {
  it("maps roles and merges consecutive same-role turns", () => {
    expect(
      toGeminiContents([
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
        { role: "assistant", content: "" },
        { role: "user", content: "d" },
      ]),
    ).toEqual([
      { role: "user", parts: [{ text: "a" }, { text: "b" }] },
      { role: "model", parts: [{ text: "c" }] },
      { role: "user", parts: [{ text: "d" }] },
    ]);
  });
});

describe("GeminiProvider.streamChat", () => {
  it("streams text deltas, skips thoughts and reports usage including thinking tokens", async () => {
    let request: GenerateContentParameters | undefined;
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "gemini-test",
      client: stubClient({
        onRequest: (params) => (request = params),
        chunks: [
          { candidates: [{ content: { role: "model", parts: [{ text: "thinking…", thought: true }] } }] },
          textChunk("Hello"),
          textChunk(", world", {
            candidates: [{ content: { role: "model", parts: [{ text: ", world" }] }, finishReason: "STOP" as never }],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 24 },
          }),
        ],
      }),
    });

    const chunks = await collect(
      provider.streamChat({
        model: "gemini-test",
        system: "Be brief.",
        temperature: 0.2,
        messages: [{ role: "user", content: "Hi" }],
      }),
    );

    expect(chunks).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: ", world" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 12, totalTokens: 24 } },
    ]);
    expect(request?.model).toBe("gemini-test");
    expect(request?.config?.systemInstruction).toBe("Be brief.");
    expect(request?.config?.temperature).toBe(0.2);
  });

  it("requests JSON output when a response schema is given", async () => {
    let request: GenerateContentParameters | undefined;
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({ onRequest: (params) => (request = params), chunks: [textChunk('{"ok":true}')] }),
    });
    const result = await completeChat(provider, {
      model: "m",
      messages: [{ role: "user", content: "x" }],
      responseFormat: { type: "json", schema },
    });
    expect(result.text).toBe('{"ok":true}');
    expect(request?.config?.responseMimeType).toBe("application/json");
    expect(request?.config?.responseJsonSchema).toEqual(schema);
  });

  it("maps MAX_TOKENS to a length finish reason", async () => {
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({
        chunks: [
          { candidates: [{ content: { role: "model", parts: [{ text: "cut" }] }, finishReason: "MAX_TOKENS" as never }] },
        ],
      }),
    });
    const chunks = await collect(provider.streamChat({ model: "m", messages: [{ role: "user", content: "x" }] }));
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "length" });
  });

  it("raises content_blocked for blocked prompts and safety stops", async () => {
    const blocked = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({ chunks: [{ promptFeedback: { blockReason: "SAFETY" as never } }] }),
    });
    await expect(collect(blocked.streamChat({ model: "m", messages: [{ role: "user", content: "x" }] }))).rejects.toMatchObject({
      code: "content_blocked",
    });

    const stopped = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({
        chunks: [{ candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY" as never }] }],
      }),
    });
    await expect(collect(stopped.streamChat({ model: "m", messages: [{ role: "user", content: "x" }] }))).rejects.toMatchObject({
      code: "content_blocked",
    });
  });

  it.each([
    [401, "authentication", false],
    [404, "model_not_found", false],
    [429, "rate_limited", true],
    [503, "unavailable", true],
  ] as const)("maps HTTP %i to %s", async (status, code, retryable) => {
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({ failWith: new ApiError({ message: "raw vendor message", status }) }),
    });
    const error = await collect(provider.streamChat({ model: "m", messages: [{ role: "user", content: "x" }] })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, retryable, status });
    expect((error as Error).message).not.toContain("raw vendor message");
  });

  it("maps Gemini's 400 API_KEY_INVALID response to an authentication error", async () => {
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({
        failWith: new ApiError({
          message: '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
          status: 400,
        }),
      }),
    });
    await expect(collect(provider.streamChat({ model: "m", messages: [{ role: "user", content: "x" }] }))).rejects.toMatchObject({
      code: "authentication",
      message: "Gemini rejected the API key. Check GEMINI_API_KEY.",
    });
  });

  it("maps mid-stream failures after partial output", async () => {
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({
        chunks: [textChunk("partial"), textChunk("never")],
        failAfter: 1,
        failWith: new ApiError({ message: "boom", status: 500 }),
      }),
    });
    const received: ChatStreamChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of provider.streamChat({ model: "m", messages: [{ role: "user", content: "x" }] })) {
          received.push(chunk);
        }
      })(),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(received).toEqual([{ type: "text-delta", text: "partial" }]);
  });

  it("stops with an aborted error when the signal fires", async () => {
    const controller = new AbortController();
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({ chunks: [textChunk("one"), textChunk("two"), textChunk("three")] }),
    });
    const received: ChatStreamChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of provider.streamChat({
          model: "m",
          messages: [{ role: "user", content: "x" }],
          signal: controller.signal,
        })) {
          received.push(chunk);
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(received).toHaveLength(1);
  });

  it("reports not_configured without an API key", async () => {
    const provider = new GeminiProvider({ apiKey: undefined, defaultModel: "m" });
    expect(provider.isConfigured()).toBe(false);
    await expect(collect(provider.streamChat({ model: "m", messages: [] }))).rejects.toMatchObject({
      code: "not_configured",
    });
  });
});

describe("GeminiProvider.listModels", () => {
  it("keeps only text-generation Gemini models", async () => {
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({
        models: [
          { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedActions: ["generateContent"], inputTokenLimit: 1_048_576 },
          { name: "models/gemini-embedding-001", supportedActions: ["embedContent"] },
          { name: "models/gemini-2.5-flash-preview-tts", supportedActions: ["generateContent"] },
          { name: "models/imagen-4.0-generate-001", supportedActions: ["predict"] },
          { name: "models/gemini-2.5-pro", supportedActions: ["generateContent", "countTokens"] },
        ],
      }),
    });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
    expect(models[1]).toMatchObject({ label: "Gemini 2.5 Flash", inputTokenLimit: 1_048_576, outputTokenLimit: null });
  });
});

describe("GeminiProvider.listModels with an allowlist", () => {
  const available: Partial<Model>[] = [
    { name: "models/gemini-3.5-flash-lite", supportedActions: ["generateContent"] },
    { name: "models/gemini-3.1-flash-lite", supportedActions: ["generateContent"] },
    { name: "models/gemini-3.8-flash", supportedActions: ["generateContent"] },
  ];

  it("returns only allowlisted models in allowlist order, default first", async () => {
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "gemini-3.1-flash-lite",
      allowedModels: ["gemini-3.5-flash-lite"],
      client: stubClient({ models: available }),
    });
    expect((await provider.listModels()).map((m) => m.id)).toEqual(["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]);
  });

  it("skips allowlisted ids the API key cannot use", async () => {
    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const provider = new GeminiProvider({
        apiKey: undefined,
        defaultModel: "gemini-3.1-flash-lite",
        allowedModels: ["gemini-3.1-flash-lite", "gemini-typo"],
        client: stubClient({ models: available }),
      });
      expect((await provider.listModels()).map((m) => m.id)).toEqual(["gemini-3.1-flash-lite"]);
      expect(String(warnings[0])).toContain("gemini-typo");
    } finally {
      console.warn = originalWarn;
    }
  });
});

/**
 * Live smoke test against the real Gemini API. Runs only when GEMINI_API_KEY
 * is present so CI without credentials is not blocked.
 */
describe.skipIf(!process.env.GEMINI_API_KEY)("Gemini live API", () => {
  it("streams a real response", { timeout: 60_000 }, async () => {
    const provider = new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY,
      defaultModel: process.env.GEMINI_DEFAULT_MODEL ?? "gemini-2.5-flash",
    });
    const chunks = await collect(
      provider.streamChat({
        model: provider.defaultModel,
        messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
      }),
    );
    const text = chunks.flatMap((c) => (c.type === "text-delta" ? [c.text] : [])).join("");
    expect(text.toLowerCase()).toContain("pong");
    expect(chunks.at(-1)).toMatchObject({ type: "finish" });
  });
});

describe("Gemini tool calling", () => {
  const tools = [
    { name: "files.read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  ];

  it("declares tools with safe names and streams tool calls with thought signatures", async () => {
    let request: GenerateContentParameters | undefined;
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({
        onRequest: (params) => (request = params),
        chunks: [
          {
            candidates: [
              {
                content: { role: "model", parts: [{ functionCall: { id: "call_1", name: "files_read", args: { path: "a.txt" } }, thoughtSignature: "sig-123" }] },
                finishReason: "STOP" as never,
              },
            ],
          },
        ],
      }),
    });
    const result = await completeChat(provider, { model: "m", messages: [{ role: "user", content: "read a.txt" }], tools });
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "files.read", arguments: { path: "a.txt" }, providerMetadata: { thoughtSignature: "sig-123" } },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    const declaration = (request?.config?.tools as { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] }[])[0]!
      .functionDeclarations[0]!;
    expect(declaration.name).toBe("files_read");
    expect(declaration.parametersJsonSchema).toEqual(tools[0]!.parameters);
  });

  it("generates an id when Gemini omits one", async () => {
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({ chunks: [{ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "files_read", args: {} } }] } }] }] }),
    });
    const { toolCalls } = await completeChat(provider, { model: "m", messages: [{ role: "user", content: "x" }], tools });
    expect(toolCalls[0]?.id).toMatch(/^call_/);
  });

  it("echoes tool calls with signatures and merges tool results into one user turn", () => {
    const contents = toGeminiContents([
      { role: "user", content: "read two files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "files.read", arguments: { path: "a" }, providerMetadata: { thoughtSignature: "sig" } },
          { id: "c2", name: "files.read", arguments: { path: "b" } },
        ],
      },
      { role: "tool", toolCallId: "c1", name: "files.read", content: "A" },
      { role: "tool", toolCallId: "c2", name: "files.read", content: "B" },
    ]);
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "read two files" }] },
      {
        role: "model",
        parts: [
          { functionCall: { id: "c1", name: "files_read", args: { path: "a" } }, thoughtSignature: "sig" },
          { functionCall: { id: "c2", name: "files_read", args: { path: "b" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "c1", name: "files_read", response: { output: "A" } } },
          { functionResponse: { id: "c2", name: "files_read", response: { output: "B" } } },
        ],
      },
    ]);
  });

  it("collects grounded search answers, queries and unique sources", async () => {
    let request: GenerateContentParameters | undefined;
    const provider = new GeminiProvider({
      apiKey: undefined,
      defaultModel: "m",
      client: stubClient({
        onRequest: (params) => (request = params),
        chunks: [
          textChunk("Node 24 is current.", {
            candidates: [
              {
                content: { role: "model", parts: [{ text: "Node 24 is current." }] },
                groundingMetadata: {
                  webSearchQueries: ["latest node version"],
                  groundingChunks: [
                    { web: { uri: "https://nodejs.org", title: "nodejs.org" } },
                    { web: { uri: "https://nodejs.org", title: "nodejs.org" } },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
          }),
        ],
      }),
    });
    const result = await provider.groundedSearch("latest node");
    expect(request?.config?.tools).toEqual([{ googleSearch: {} }]);
    expect(result).toMatchObject({
      answer: "Node 24 is current.",
      queries: ["latest node version"],
      sources: [{ title: "nodejs.org", url: "https://nodejs.org", snippet: null }],
      usage: { totalTokens: 10 },
    });
  });
});

describe("user attachments (spec §3)", () => {
  it("sends a user's images as inline parts after their text", () => {
    const contents = toGeminiContents([
      { role: "user", content: "What is in this picture?", images: [{ mimeType: "image/png", data: "AAAA" }] },
    ]);
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({
      role: "user",
      parts: [{ text: "What is in this picture?" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }],
    });
  });

  it("sends an image with no text at all as just the image", () => {
    const contents = toGeminiContents([{ role: "user", content: "", images: [{ mimeType: "image/jpeg", data: "BBBB" }] }]);
    expect(contents[0]?.parts).toEqual([{ inlineData: { mimeType: "image/jpeg", data: "BBBB" } }]);
  });

  it("leaves a plain user turn exactly as before", () => {
    expect(toGeminiContents([{ role: "user", content: "hello" }])[0]).toMatchObject({ role: "user", parts: [{ text: "hello" }] });
  });
});
