import {
  ApiError,
  FinishReason as GeminiFinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Model,
  type Part,
} from "@google/genai";
import { ProviderError, type ProviderErrorCode } from "../errors";
import { createHash, randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamChunk,
  FinishReason,
  GroundedSearchResult,
  ModelInfo,
  ModelProvider,
  TokenUsage,
  ToolDeclaration,
  WebSearchSource,
} from "../types";

const PROVIDER_ID = "gemini";
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
/** Model families returned by models.list that are not usable for text chat. */
const NON_CHAT_MODEL = /(embedding|tts|image|live|native-audio|aqa|robotics|computer-use)/i;

/** Subset of the @google/genai client used by the provider (injectable for tests). */
export interface GeminiClient {
  models: {
    generateContentStream(
      params: GenerateContentParameters,
    ): Promise<AsyncGenerator<GenerateContentResponse>>;
    list(): Promise<AsyncIterable<Model>>;
  };
}

export interface GeminiProviderOptions {
  apiKey: string | undefined;
  defaultModel: string;
  /**
   * Restricts selectable models to these ids, in this order. The default model
   * is always included. Omit to offer every text model the API key can use.
   */
  allowedModels?: string[] | undefined;
  /** Overrides the SDK client; used in tests. */
  client?: GeminiClient;
}

export class GeminiProvider implements ModelProvider {
  readonly id = PROVIDER_ID;
  readonly name = "Google Gemini";
  readonly defaultModel: string;

  private readonly apiKey: string | undefined;
  private readonly allowedModels: string[] | undefined;
  private client: GeminiClient | undefined;
  private modelCache: { models: ModelInfo[]; expiresAt: number } | undefined;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.client = options.client;
    if (options.allowedModels?.length) {
      this.allowedModels = [...new Set([options.defaultModel, ...options.allowedModels])];
    }
  }

  isConfigured(): boolean {
    return Boolean(this.client ?? this.apiKey);
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) return this.modelCache.models;

    const client = this.getClient();
    const models: ModelInfo[] = [];
    try {
      for await (const model of await client.models.list()) {
        const info = toModelInfo(model);
        if (info) models.push(info);
      }
    } catch (error) {
      throw toProviderError(error);
    }

    let result: ModelInfo[];
    if (this.allowedModels) {
      const byId = new Map(models.map((m) => [m.id, m]));
      const missing = this.allowedModels.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        console.warn(`Gemini models not available for this API key: ${missing.join(", ")}`);
      }
      result = this.allowedModels.flatMap((id) => byId.get(id) ?? []);
    } else {
      result = models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    }

    this.modelCache = { models: result, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
    return result;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const client = this.getClient();
    const { signal } = request;
    throwIfAborted(signal);

    const names = toolNameMap(request.tools ?? []);
    let stream: AsyncGenerator<GenerateContentResponse>;
    try {
      stream = await client.models.generateContentStream({
        model: request.model,
        contents: toGeminiContents(request.messages, names.toSafe),
        config: {
          ...(request.tools?.length
            ? {
                tools: [
                  {
                    functionDeclarations: request.tools.map((tool) => ({
                      name: names.toSafe(tool.name),
                      description: tool.description,
                      parametersJsonSchema: tool.parameters,
                    })),
                  },
                ],
                ...(request.toolChoice === "none" ? { toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } } } : {}),
              }
            : {}),
          // Thought summaries are never part of the answer, and their parts can
          // stream without the "thought" flag, leaking fragments into the text.
          // Thought *signatures* (needed to echo tool calls back) are unaffected.
          thinkingConfig: { includeThoughts: false },
          ...(request.system ? { systemInstruction: request.system } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxOutputTokens !== undefined
            ? { maxOutputTokens: request.maxOutputTokens }
            : {}),
          ...(request.responseFormat?.type === "json"
            ? { responseMimeType: "application/json", responseJsonSchema: request.responseFormat.schema }
            : {}),
          ...(signal ? { abortSignal: signal } : {}),
        },
      });
    } catch (error) {
      throw toProviderError(error, signal);
    }

    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finishReason: FinishReason = "stop";
    let rawFinishReason: string | undefined;
    let sawToolCall = false;

    try {
      for await (const chunk of stream) {
        throwIfAborted(signal);

        const blockReason = chunk.promptFeedback?.blockReason;
        if (blockReason) {
          throw new ProviderError(
            "content_blocked",
            `Gemini blocked the prompt (${blockReason}).`,
            { provider: PROVIDER_ID },
          );
        }

        const text = extractText(chunk);
        if (text) yield { type: "text-delta", text };

        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (!part.functionCall?.name) continue;
          sawToolCall = true;
          yield {
            type: "tool-call",
            call: {
              id: part.functionCall.id ?? `call_${randomUUID()}`,
              name: names.fromSafe(part.functionCall.name),
              arguments: part.functionCall.args ?? {},
              ...(part.thoughtSignature ? { providerMetadata: { thoughtSignature: part.thoughtSignature } } : {}),
            },
          };
        }

        if (chunk.usageMetadata) usage = toUsage(chunk.usageMetadata);
        const reason = chunk.candidates?.[0]?.finishReason;
        if (reason) {
          rawFinishReason = reason;
          finishReason = mapFinishReason(reason);
        }
      }
    } catch (error) {
      throw toProviderError(error, signal);
    }

    throwIfAborted(signal);
    if (finishReason === "content_filter") {
      throw new ProviderError(
        "content_blocked",
        `Gemini stopped the response (${rawFinishReason ?? "safety"}).`,
        { provider: PROVIDER_ID },
      );
    }
    yield { type: "finish", finishReason: sawToolCall && finishReason === "stop" ? "tool_calls" : finishReason, usage };
  }

  /**
   * Answers a query using Gemini's Google Search grounding and returns the
   * cited web sources. Availability depends on the API key's plan and quota.
   */
  async groundedSearch(query: string, options: { model?: string; signal?: AbortSignal } = {}): Promise<GroundedSearchResult> {
    const client = this.getClient();
    const model = options.model ?? this.defaultModel;
    const { signal } = options;
    throwIfAborted(signal);

    let answer = "";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const sources = new Map<string, WebSearchSource>();
    const queries = new Set<string>();
    try {
      const stream = await client.models.generateContentStream({
        model,
        contents: [{ role: "user", parts: [{ text: query }] }],
        config: {
          thinkingConfig: { includeThoughts: false },
          tools: [{ googleSearch: {} }],
          systemInstruction:
            "Search the web and answer the query concisely with the key facts found. Do not speculate beyond the search results.",
          ...(signal ? { abortSignal: signal } : {}),
        },
      });
      for await (const chunk of stream) {
        throwIfAborted(signal);
        answer += extractText(chunk);
        if (chunk.usageMetadata) usage = toUsage(chunk.usageMetadata);
        const metadata = chunk.candidates?.[0]?.groundingMetadata;
        for (const q of metadata?.webSearchQueries ?? []) queries.add(q);
        for (const source of metadata?.groundingChunks ?? []) {
          const uri = source.web?.uri;
          if (uri && !sources.has(uri)) sources.set(uri, { title: source.web?.title ?? uri, url: uri, snippet: null });
        }
      }
    } catch (error) {
      throw toProviderError(error, signal);
    }
    return { answer, sources: [...sources.values()], queries: [...queries], usage, model };
  }

  private getClient(): GeminiClient {
    if (this.client) return this.client;
    if (!this.apiKey) {
      throw new ProviderError(
        "not_configured",
        "Gemini is not configured. Set GEMINI_API_KEY on the server.",
        { provider: PROVIDER_ID },
      );
    }
    const client: GeminiClient = new GoogleGenAI({ apiKey: this.apiKey });
    this.client = client;
    return client;
  }
}

const SAFE_TOOL_NAME = /[^a-zA-Z0-9_]/g;

const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Gemini function names allow only [a-zA-Z0-9_] and at most 64 characters;
 * map tool names (e.g. "github.search_repositories") both ways. Long or
 * colliding names get a short hash suffix so every tool stays distinct.
 */
export function toolNameMap(tools: Pick<ToolDeclaration, "name">[]) {
  const toSafeMap = new Map<string, string>();
  const fromSafeMap = new Map<string, string>();
  for (const tool of tools) {
    if (toSafeMap.has(tool.name)) continue;
    let safe = tool.name.replace(SAFE_TOOL_NAME, "_");
    if (!/^[a-zA-Z_]/.test(safe)) safe = `_${safe}`;
    if (safe.length > MAX_TOOL_NAME_LENGTH || fromSafeMap.has(safe)) {
      const hash = createHash("sha256").update(tool.name).digest("hex").slice(0, 8);
      safe = `${safe.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${hash}`;
    }
    toSafeMap.set(tool.name, safe);
    fromSafeMap.set(safe, tool.name);
  }
  return {
    toSafe: (name: string) => toSafeMap.get(name) ?? name.replace(SAFE_TOOL_NAME, "_"),
    fromSafe: (name: string) => fromSafeMap.get(name) ?? name,
  };
}

/**
 * Converts provider-neutral messages to Gemini contents: tool calls become
 * functionCall parts (with their thought signatures echoed back), tool results
 * become functionResponse parts, and consecutive same-role turns are merged.
 */
export function toGeminiContents(messages: ChatMessage[], toSafeName: (name: string) => string = (n) => n.replace(SAFE_TOOL_NAME, "_")): Content[] {
  const contents: Content[] = [];
  const append = (role: "user" | "model", parts: Part[]) => {
    if (parts.length === 0) return;
    const previous = contents[contents.length - 1];
    if (previous && previous.role === role) previous.parts?.push(...parts);
    else contents.push({ role, parts });
  };

  for (const message of messages) {
    if (message.role === "user") {
      const attached = (message.images ?? []).map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } }));
      // Text first, then the pictures it refers to.
      const parts: Part[] = [...(message.content ? [{ text: message.content }] : []), ...attached];
      if (parts.length > 0) append("user", parts);
    } else if (message.role === "assistant") {
      const parts: Part[] = message.content ? [{ text: message.content }] : [];
      for (const call of message.toolCalls ?? []) {
        const signature = call.providerMetadata?.thoughtSignature;
        parts.push({
          functionCall: { id: call.id, name: toSafeName(call.name), args: call.arguments },
          ...(typeof signature === "string" ? { thoughtSignature: signature } : {}),
        });
      }
      append("model", parts);
    } else {
      // Images belong inside the function response's own parts. As sibling parts
      // of the same turn, the model prefixes its answer with stray tokens.
      const images = (message.images ?? []).map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } }));
      append("user", [
        {
          functionResponse: {
            id: message.toolCallId,
            name: toSafeName(message.name),
            response: { output: message.content },
            ...(images.length ? { parts: images } : {}),
          },
        },
      ]);
    }
  }
  return contents;
}

function extractText(chunk: GenerateContentResponse): string {
  const parts = chunk.candidates?.[0]?.content?.parts ?? [];
  // Thought summaries are not part of the answer.
  return parts
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("");
}

function toUsage(metadata: NonNullable<GenerateContentResponse["usageMetadata"]>): TokenUsage {
  const inputTokens = metadata.promptTokenCount ?? 0;
  // Thinking tokens are billed as output tokens.
  const outputTokens = (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: metadata.totalTokenCount ?? inputTokens + outputTokens,
  };
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case GeminiFinishReason.STOP:
      return "stop";
    case GeminiFinishReason.MAX_TOKENS:
      return "length";
    case GeminiFinishReason.SAFETY:
    case GeminiFinishReason.RECITATION:
    case GeminiFinishReason.BLOCKLIST:
    case GeminiFinishReason.PROHIBITED_CONTENT:
    case GeminiFinishReason.SPII:
      return "content_filter";
    default:
      return "other";
  }
}

function toModelInfo(model: Model): ModelInfo | null {
  const name = model.name?.replace(/^models\//, "");
  if (!name || !name.startsWith("gemini")) return null;
  if (!model.supportedActions?.includes("generateContent")) return null;
  if (NON_CHAT_MODEL.test(name)) return null;
  return {
    id: name,
    label: model.displayName ?? name,
    provider: PROVIDER_ID,
    inputTokenLimit: model.inputTokenLimit ?? null,
    outputTokenLimit: model.outputTokenLimit ?? null,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ProviderError("aborted", "The request was cancelled.", { provider: PROVIDER_ID });
  }
}

export function toProviderError(error: unknown, signal?: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new ProviderError("aborted", "The request was cancelled.", {
      provider: PROVIDER_ID,
      cause: error,
    });
  }

  const status = error instanceof ApiError ? error.status : undefined;
  // Gemini reports a bad API key as 400 INVALID_ARGUMENT with reason API_KEY_INVALID.
  const invalidKey = error instanceof ApiError && /API_KEY_INVALID|API key not valid/i.test(error.message);
  const [code, message] = invalidKey ? classifyStatus(401) : classifyStatus(status);
  const retryAfterMs = status === 429 && error instanceof ApiError ? parseRetryDelay(error.message) : undefined;
  return new ProviderError(code, message, {
    provider: PROVIDER_ID,
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    cause: error,
  });
}

/** Reads google.rpc.RetryInfo ("retryDelay": "23s" or "1.5s") from an error body. */
export function parseRetryDelay(body: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

function classifyStatus(status: number | undefined): [ProviderErrorCode, string] {
  if (status === 400) return ["invalid_request", "Gemini rejected the request as invalid."];
  if (status === 401 || status === 403) {
    return ["authentication", "Gemini rejected the API key. Check GEMINI_API_KEY."];
  }
  if (status === 404) return ["model_not_found", "The selected Gemini model was not found."];
  if (status === 429) {
    return ["rate_limited", "Gemini rate limit or quota exceeded. Try again shortly."];
  }
  if (status !== undefined && status >= 500) {
    return ["unavailable", "Gemini is temporarily unavailable. Try again shortly."];
  }
  return ["unknown", "The request to Gemini failed."];
}
