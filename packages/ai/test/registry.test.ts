import { describe, expect, it } from "vitest";
import { estimateCostUsd, ProviderRegistry, type ModelInfo, type ModelProvider } from "../src";

function fakeProvider(overrides: Partial<ModelProvider> & { models?: string[] } = {}): ModelProvider {
  const models: ModelInfo[] = (overrides.models ?? ["model-a", "model-b"]).map((id) => ({
    id,
    label: id,
    provider: "fake",
    inputTokenLimit: null,
    outputTokenLimit: null,
  }));
  return {
    id: "fake",
    name: "Fake",
    defaultModel: "model-a",
    isConfigured: () => true,
    listModels: async () => models,
    streamChat: async function* () {},
    ...overrides,
  };
}

describe("ProviderRegistry", () => {
  it("requires the default provider to be registered", () => {
    expect(() => new ProviderRegistry([fakeProvider()], "missing")).toThrow();
  });

  it("resolves the default model without listing models", async () => {
    let listed = false;
    const registry = new ProviderRegistry(
      [fakeProvider({ listModels: async () => ((listed = true), []) })],
      "fake",
    );
    const resolved = await registry.resolveModel(undefined);
    expect(resolved.model).toBe("model-a");
    expect(listed).toBe(false);
  });

  it("accepts listed models and rejects unknown ones", async () => {
    const registry = new ProviderRegistry([fakeProvider()], "fake");
    expect((await registry.resolveModel("model-b")).model).toBe("model-b");
    await expect(registry.resolveModel("../../etc/passwd")).rejects.toMatchObject({
      code: "model_not_found",
    });
  });

  it("rejects unconfigured providers", async () => {
    const registry = new ProviderRegistry([fakeProvider({ isConfigured: () => false })], "fake");
    await expect(registry.resolveModel(undefined)).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("estimateCostUsd", () => {
  it("prices known models and tiers", () => {
    expect(
      estimateCostUsd("gemini", "gemini-2.5-flash", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
      }),
    ).toBeCloseTo(2.8);
    expect(
      estimateCostUsd("gemini", "gemini-2.5-pro", {
        inputTokens: 300_000,
        outputTokens: 0,
        totalTokens: 300_000,
      }),
    ).toBeCloseTo(0.75);
  });

  it("prices the Gemini Flash-Lite models", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };
    expect(estimateCostUsd("gemini", "gemini-3.1-flash-lite", usage)).toBeCloseTo(1.75);
    expect(estimateCostUsd("gemini", "gemini-3.5-flash-lite", usage)).toBeCloseTo(2.8);
  });

  it("returns null for unknown models instead of guessing", () => {
    expect(
      estimateCostUsd("gemini", "gemini-unknown", { inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    ).toBeNull();
  });
});

describe("isProviderError", () => {
  it("recognises ProviderErrors from another module copy by shape", async () => {
    const { isProviderError, ProviderError } = await import("../src");
    expect(isProviderError(new ProviderError("unknown", "x", { provider: "p" }))).toBe(true);
    const foreign = Object.assign(new Error("x"), { name: "ProviderError", code: "rate_limited", provider: "gemini" });
    expect(isProviderError(foreign)).toBe(true);
    expect(isProviderError(new Error("x"))).toBe(false);
  });
});

describe("parseRetryDelay", () => {
  it("reads RetryInfo delays from Gemini error bodies", async () => {
    const { parseRetryDelay } = await import("../src");
    expect(parseRetryDelay('{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"23s"}]}}')).toBe(23_000);
    expect(parseRetryDelay('"retryDelay": "1.5s"')).toBe(1500);
    expect(parseRetryDelay("no hint")).toBeUndefined();
  });
});

describe("toolNameMap", () => {
  it("maps tool names to valid, distinct Gemini function names and back", async () => {
    const { toolNameMap } = await import("../src");
    const long = `github.${"x".repeat(80)}`;
    const names = ["files.read", "github.search_repositories", "github_search.repositories", long, "9lives.tool"];
    const map = toolNameMap(names.map((name) => ({ name })));
    const safe = names.map((n) => map.toSafe(n));
    expect(safe[0]).toBe("files_read");
    expect(new Set(safe).size).toBe(names.length);
    for (const s of safe) expect(s).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
    for (const [i, s] of safe.entries()) expect(map.fromSafe(s)).toBe(names[i]);
  });
});

describe("toGeminiContents with tool images", () => {
  it("nests images inside the function response (sibling parts make the model emit stray tokens)", async () => {
    const { toGeminiContents } = await import("../src");
    const contents = toGeminiContents([
      { role: "user", content: "look" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "computer.start", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "computer.start", content: "Started.", images: [{ mimeType: "image/jpeg", data: "AAAA" }] },
    ]);
    const toolTurn = contents.at(-1)!;
    expect(toolTurn.role).toBe("user");
    expect(toolTurn.parts).toHaveLength(1);
    const response = toolTurn.parts![0]!.functionResponse!;
    expect(response.name).toBe("computer_start");
    expect(response.response).toEqual({ output: "Started." });
    expect(response.parts).toEqual([{ inlineData: { mimeType: "image/jpeg", data: "AAAA" } }]);
  });
});
