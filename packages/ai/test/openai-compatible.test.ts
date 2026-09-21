import { describe, expect, it } from "vitest";
import { isProviderError, OpenAICompatibleProvider, parseRetryAfter, toOpenAIMessages, type ChatStreamChunk } from "../src";

/** Builds an SSE body from chunk objects, the way a gateway streams them. */
function sse(chunks: unknown[], { done = true } = {}): string {
  const frames = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  return frames.join("") + (done ? "data: [DONE]\n\n" : "");
}

function streamResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" }, ...init });
}

function provider(fetchImpl: typeof fetch, options: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider({
    baseUrl: "http://gateway.test/v1",
    apiKey: "sk-test",
    defaultModel: "test-model",
    fetchImpl,
    ...options,
  });
}

async function collect(stream: AsyncIterable<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const chunks: ChatStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const textOf = (chunks: ChatStreamChunk[]) => chunks.flatMap((c) => (c.type === "text-delta" ? [c.text] : [])).join("");
const callsOf = (chunks: ChatStreamChunk[]) => chunks.flatMap((c) => (c.type === "tool-call" ? [c.call] : []));

describe("OpenAICompatibleProvider configuration", () => {
  it("is configured by a base URL alone, because local gateways need no key", () => {
    expect(provider(fetch, { apiKey: undefined }).isConfigured()).toBe(true);
    expect(provider(fetch, { baseUrl: undefined }).isConfigured()).toBe(false);
  });

  it("names itself from options so a self-hosted gateway reads as itself", () => {
    expect(provider(fetch).name).toBe("OpenAI-compatible");
    expect(provider(fetch, { name: "Home GPU" }).name).toBe("Home GPU");
  });

  it("sends the key as a bearer token, and omits the header when there is none", async () => {
    const seen: RequestInit[] = [];
    const spy: typeof fetch = async (_url, init) => {
      seen.push(init!);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    await provider(spy).listModels();
    await provider(spy, { apiKey: undefined }).listModels();
    expect((seen[0]!.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect((seen[1]!.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("listModels", () => {
  const body = JSON.stringify({
    data: [
      { id: "b-model", context_length: 8000, max_output_tokens: 1000 },
      { id: "a-model", max_input_tokens: 4000 },
      { id: "" },
    ],
  });

  it("maps ids and limits, drops empties and sorts", async () => {
    const models = await provider(async () => new Response(body, { status: 200 })).listModels();
    expect(models.map((m) => m.id)).toEqual(["a-model", "b-model"]);
    expect(models[1]).toMatchObject({ provider: "openai-compatible", inputTokenLimit: 8000, outputTokenLimit: 1000 });
    expect(models[0]).toMatchObject({ inputTokenLimit: 4000, outputTokenLimit: null });
  });

  it("applies the allowlist in order and always includes the default model", async () => {
    const models = await provider(async () => new Response(body, { status: 200 }), {
      defaultModel: "b-model",
      allowedModels: ["a-model"],
    }).listModels();
    expect(models.map((m) => m.id)).toEqual(["b-model", "a-model"]);
  });

  it("keeps an allowlisted id the gateway does not advertise, because aliases are routable", async () => {
    const models = await provider(async () => new Response(body, { status: 200 }), { allowedModels: ["auto/best-coding"] }).listModels();
    expect(models.map((m) => m.id)).toContain("auto/best-coding");
  });

  it("caches, so the picker does not hammer the gateway", async () => {
    let calls = 0;
    const p = provider(async () => {
      calls++;
      return new Response(body, { status: 200 });
    });
    await p.listModels();
    await p.listModels();
    expect(calls).toBe(1);
  });
});

describe("streamChat", () => {
  it("streams text and reports usage and finish reason", async () => {
    const p = provider(async () =>
      streamResponse(
        sse([
          { choices: [{ delta: { content: "Hello" } }] },
          { choices: [{ delta: { content: " world" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
        ]),
      ),
    );
    const chunks = await collect(p.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] }));
    expect(textOf(chunks)).toBe("Hello world");
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } });
  });

  it("assembles a tool call whose arguments arrive in fragments", async () => {
    const p = provider(async () =>
      streamResponse(
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "files.read", arguments: '{"pa' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );
    const chunks = await collect(p.streamChat({ model: "m", messages: [{ role: "user", content: "read it" }] }));
    expect(callsOf(chunks)).toEqual([{ id: "call_1", name: "files.read", arguments: { path: "a.txt" } }]);
    expect(chunks.at(-1)).toMatchObject({ finishReason: "tool_calls" });
  });

  it("keeps parallel tool calls separate and in index order", async () => {
    const p = provider(async () =>
      streamResponse(
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "second", arguments: "{}" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "first", arguments: '{"x":1}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );
    expect(callsOf(await collect(p.streamChat({ model: "m", messages: [] })))).toEqual([
      { id: "a", name: "first", arguments: { x: 1 } },
      { id: "b", name: "second", arguments: {} },
    ]);
  });

  it("never emits a reasoning model's thinking as answer text", async () => {
    const p = provider(async () =>
      streamResponse(
        sse([
          { choices: [{ delta: { content: null, reasoning_content: "The user wants X, so I will…" } }] },
          { choices: [{ delta: { content: "42" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      ),
    );
    expect(textOf(await collect(p.streamChat({ model: "m", messages: [] })))).toBe("42");
  });

  it("survives a malformed frame and \\r\\n framing from a proxy", async () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\r\n\r\ndata: {not json\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const chunks = await collect(provider(async () => streamResponse(body)).streamChat({ model: "m", messages: [] }));
    expect(textOf(chunks)).toBe("ok");
    expect(chunks.at(-1)).toMatchObject({ finishReason: "stop" });
  });

  it("asks for usage, and maps tools, tool_choice and response_format", async () => {
    let sent: Record<string, unknown> = {};
    const p = provider(async (_url, init) => {
      sent = JSON.parse(String(init!.body)) as Record<string, unknown>;
      return streamResponse(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]));
    });

    await collect(
      p.streamChat({
        model: "m",
        messages: [],
        tools: [{ name: "files.read", description: "Read", parameters: { type: "object" } }],
        toolChoice: "none",
        temperature: 0.2,
        maxOutputTokens: 256,
      }),
    );
    expect(sent).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "none",
      temperature: 0.2,
      max_tokens: 256,
    });
    expect((sent.tools as { function: { name: string } }[])[0]!.function.name).toBe("files.read");

    await collect(p.streamChat({ model: "m", messages: [], responseFormat: { type: "json", schema: { type: "object" } } }));
    // json_schema, not json_object: json_object ignores the schema and the
    // planner's output then fails to parse.
    expect(sent.response_format).toMatchObject({ type: "json_schema", json_schema: { schema: { type: "object" } } });
  });
});

describe("message mapping", () => {
  it("places the system prompt first and maps every role", () => {
    const mapped = toOpenAIMessages(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "files.read", arguments: { path: "a" } }] },
        { role: "tool", toolCallId: "c1", name: "files.read", content: "contents" },
      ],
      "You are helpful.",
    );
    expect(mapped[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(mapped[1]).toEqual({ role: "user", content: "hi" });
    expect(mapped[2]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "files.read", arguments: '{"path":"a"}' } }],
    });
    expect(mapped[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "contents" });
  });

  it("sends a user's images as image_url parts after the text", () => {
    const [message] = toOpenAIMessages([
      { role: "user", content: "what is this?", images: [{ mimeType: "image/png", data: "AAAA" }] },
    ]);
    expect(message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  it("carries a tool's screenshot as its own user turn, since tool messages cannot hold images", () => {
    const mapped = toOpenAIMessages([
      { role: "tool", toolCallId: "c1", name: "browser.screenshot", content: "done", images: [{ mimeType: "image/jpeg", data: "BBBB" }] },
    ]);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({ role: "tool" });
    expect(mapped[1]).toMatchObject({ role: "user", content: [{ type: "text" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } }] });
  });
});

describe("errors", () => {
  const cases: [number, string][] = [
    [401, "authentication"],
    [403, "authentication"],
    [404, "model_not_found"],
    [429, "rate_limited"],
    [400, "invalid_request"],
    [500, "unavailable"],
  ];

  for (const [status, code] of cases) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      const p = provider(async () => new Response(JSON.stringify({ error: { message: "nope" } }), { status }));
      await expect(collect(p.streamChat({ model: "m", messages: [] }))).rejects.toMatchObject({ code, provider: "openai-compatible", status });
    });
  }

  it("repeats the gateway's own 401 message, which often means the model, not the key", async () => {
    // Real behaviour of a self-hosted gateway: an unroutable model id comes
    // back as 401 "No active credentials for provider: does."
    const p = provider(async () => new Response(JSON.stringify({ error: { message: "No active credentials for provider: does." } }), { status: 401 }));
    const error = await collect(p.streamChat({ model: "does/not/exist", messages: [] })).catch((e: unknown) => e);
    expect((error as Error).message).toContain("No active credentials for provider");
  });

  it("honours Retry-After on a 429 so the runtime waits the right amount", async () => {
    const p = provider(async () => new Response("{}", { status: 429, headers: { "Retry-After": "12" } }));
    await expect(collect(p.streamChat({ model: "m", messages: [] }))).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 12_000 });
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("nonsense")).toBeUndefined();
  });

  it("reports an unreachable gateway as unavailable, and a retryable one", async () => {
    const p = provider(async () => {
      throw new Error("ECONNREFUSED");
    });
    const error = await collect(p.streamChat({ model: "m", messages: [] })).catch((e: unknown) => e);
    expect(isProviderError(error) && error.code).toBe("unavailable");
    expect(isProviderError(error) && error.retryable).toBe(true);
  });

  it("reports an already-aborted request as aborted without calling the gateway", async () => {
    let called = false;
    const p = provider(async () => {
      called = true;
      return streamResponse(sse([]));
    });
    const controller = new AbortController();
    controller.abort();
    await expect(collect(p.streamChat({ model: "m", messages: [], signal: controller.signal }))).rejects.toMatchObject({ code: "aborted" });
    expect(called).toBe(false);
  });

  it("refuses to stream when no base URL is configured", async () => {
    const p = provider(fetch, { baseUrl: undefined });
    await expect(collect(p.streamChat({ model: "m", messages: [] }))).rejects.toMatchObject({ code: "not_configured" });
  });
});
