import { ProviderError } from "../errors";
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamChunk,
  FinishReason,
  ModelInfo,
  ModelProvider,
  ToolCallRequest,
  TokenUsage,
} from "../types";

const PROVIDER_ID = "openai-compatible";
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export interface OpenAICompatibleProviderOptions {
  /**
   * Registry id. Defaults to `openai-compatible`. Set it when more than one
   * such server is registered (a LAN gateway *and* OpenRouter, say), because
   * the registry is keyed by id and agents store the id they were given.
   */
  id?: string | undefined;
  /** Base URL including the version path, e.g. https://host/v1. Unset = not configured. */
  baseUrl: string | undefined;
  /** Bearer token. Optional: local gateways such as Ollama accept requests without one. */
  apiKey?: string | undefined;
  /**
   * Whether the key is mandatory. Hosted services reject unauthenticated
   * requests, so a URL alone does not make them usable; local gateways do not
   * care. Only affects what `isConfigured()` reports.
   */
  requiresApiKey?: boolean | undefined;
  /** Sent with every request, e.g. OpenRouter's app-attribution headers. */
  extraHeaders?: Record<string, string> | undefined;
  defaultModel: string;
  /** Shown in the UI, so a self-hosted gateway can be named after itself. */
  name?: string | undefined;
  /**
   * Restricts selectable models to these ids, in this order. The default model
   * is always included. A gateway can advertise hundreds of models, which makes
   * an unfiltered picker unusable, so setting this is recommended.
   */
  allowedModels?: string[] | undefined;
  /** Overrides fetch; used in tests. */
  fetchImpl?: typeof fetch;
}

/** One `choices[0].delta` from a streamed chat completion. */
interface StreamDelta {
  content?: string | null;
  /**
   * Reasoning models put their thinking here. It is never part of the answer.
   * Two spellings exist: vLLM and NIM gateways send `reasoning_content`,
   * OpenRouter sends `reasoning`. Both are read only so the shape is
   * documented — neither is ever emitted.
   */
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface StreamChunk {
  choices?: { delta?: StreamDelta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

/** A tool call being assembled across stream fragments. */
interface PartialToolCall {
  id: string;
  name: string;
  /** JSON text, which arrives in pieces. */
  arguments: string;
}

/**
 * Any server that speaks the OpenAI chat-completions API (spec §13): vLLM,
 * Ollama, LiteLLM, OpenRouter, a self-hosted NIM gateway, OpenAI itself.
 *
 * The base URL comes from the operator's environment, not from user input, so
 * a private or LAN address is the expected case here — unlike `web.fetch`, MCP
 * and the browser, which take untrusted input and keep their SSRF guards.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;

  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly requiresApiKey: boolean;
  private readonly extraHeaders: Record<string, string>;
  private readonly allowedModels: string[] | undefined;
  private readonly fetchImpl: typeof fetch;
  private modelCache: { models: ModelInfo[]; expiresAt: number } | undefined;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id?.trim() || PROVIDER_ID;
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.requiresApiKey = options.requiresApiKey ?? false;
    this.extraHeaders = options.extraHeaders ?? {};
    this.defaultModel = options.defaultModel;
    this.name = options.name?.trim() || "OpenAI-compatible";
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (options.allowedModels?.length) {
      this.allowedModels = [...new Set([options.defaultModel, ...options.allowedModels])];
    }
  }

  /**
   * Without a base URL there is nothing to talk to. The key is optional unless
   * the operator marked it required, which hosted services are.
   */
  isConfigured(): boolean {
    return Boolean(this.baseUrl) && (!this.requiresApiKey || Boolean(this.apiKey));
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) return this.modelCache.models;

    const body = (await this.request("/models", { method: "GET" })) as {
      data?: { id?: string; context_length?: number; max_input_tokens?: number; max_output_tokens?: number }[];
    };
    const models: ModelInfo[] = (body.data ?? [])
      .filter((m): m is { id: string } & typeof m => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({
        id: m.id,
        label: m.id,
        provider: this.id,
        inputTokenLimit: m.max_input_tokens ?? m.context_length ?? null,
        outputTokenLimit: m.max_output_tokens ?? null,
      }));

    let result: ModelInfo[];
    if (this.allowedModels) {
      const byId = new Map(models.map((m) => [m.id, m]));
      const missing = this.allowedModels.filter((id) => !byId.has(id));
      if (missing.length > 0) console.warn(`${this.name} does not offer: ${missing.join(", ")}`);
      // An allowlisted id the server did not advertise is still selectable:
      // some gateways route aliases they do not list.
      result = this.allowedModels.map((id) => byId.get(id) ?? { id, label: id, provider: this.id, inputTokenLimit: null, outputTokenLimit: null });
    } else {
      result = models.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    }

    this.modelCache = { models: result, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
    return result;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    throwIfAborted(request.signal, this.id);

    const response = await this.request("/chat/completions", {
      method: "POST",
      body: {
        model: request.model,
        messages: toOpenAIMessages(request.messages, request.system),
        stream: true,
        // Without this, most gateways omit usage from streamed responses and
        // every task would report zero tokens and zero cost.
        stream_options: { include_usage: true },
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
              })),
              tool_choice: request.toolChoice === "none" ? "none" : "auto",
            }
          : {}),
        ...(request.responseFormat
          ? {
              // json_schema, not json_object: the schema is the point, and
              // json_object alone produces free-form JSON that fails parsing.
              response_format: {
                type: "json_schema",
                json_schema: { name: "response", schema: request.responseFormat.schema, strict: false },
              },
            }
          : {}),
      },
      signal: request.signal,
      stream: true,
    });

    const partials = new Map<number, PartialToolCall>();
    let finishReason: FinishReason = "other";
    let usage: TokenUsage = ZERO_USAGE;

    for await (const chunk of readSseJson(response as Response, request.signal, this.id)) {
      const parsed = chunk as StreamChunk;
      if (parsed.usage) usage = toUsage(parsed.usage);

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      // reasoning_content is deliberately ignored: it is the model thinking,
      // not its answer, and emitting it corrupts the reply.
      if (delta?.content) yield { type: "text-delta", text: delta.content };

      for (const fragment of delta?.tool_calls ?? []) {
        const existing = partials.get(fragment.index) ?? { id: "", name: "", arguments: "" };
        partials.set(fragment.index, {
          id: fragment.id ?? existing.id,
          name: fragment.function?.name ?? existing.name,
          arguments: existing.arguments + (fragment.function?.arguments ?? ""),
        });
      }

      if (choice.finish_reason) finishReason = toFinishReason(choice.finish_reason);
    }

    // Arguments are only complete once the stream ends, so calls are emitted here.
    for (const [index, partial] of [...partials.entries()].sort((a, b) => a[0] - b[0])) {
      const call = toToolCallRequest(partial, index);
      if (call) yield { type: "tool-call", call };
    }

    yield { type: "finish", finishReason, usage };
  }

  private async request(
    path: string,
    options: { method: string; body?: unknown; signal?: AbortSignal | undefined; stream?: boolean },
  ): Promise<unknown> {
    if (!this.isConfigured()) {
      throw new ProviderError("not_configured", `${this.name} is not configured.`, { provider: this.id });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: {
          "Content-Type": "application/json",
          Accept: options.stream ? "text/event-stream" : "application/json",
          ...this.extraHeaders,
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) throw new ProviderError("aborted", "The request was cancelled.", { provider: this.id, cause: error });
      throw new ProviderError("unavailable", `Could not reach ${this.name}: ${(error as Error).message}`, {
        provider: this.id,
        cause: error,
      });
    }

    if (!response.ok) throw await this.toHttpError(response);
    if (options.stream) return response;
    return response.json();
  }

  private async toHttpError(response: Response): Promise<ProviderError> {
    const text = await response.text().catch(() => "");
    const detail = extractMessage(text);
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    const options = { provider: this.id, status: response.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };

    if (response.status === 401 || response.status === 403) {
      // Gateways also return 401 for an unroutable model ("no credentials for
      // provider X"), so the server sentence is repeated verbatim when there is
      // one: a generic "check your key" sends people after the wrong problem.
      return new ProviderError("authentication", detail ? `${this.name}: ${detail}` : `${this.name} rejected the API key.`, options);
    }
    if (response.status === 404) {
      return new ProviderError("model_not_found", detail || `${this.name} does not have that model or endpoint.`, options);
    }
    if (response.status === 429) {
      return new ProviderError("rate_limited", detail || `${this.name} is rate limiting requests.`, options);
    }
    if (response.status >= 500) {
      return new ProviderError("unavailable", detail || `${this.name} returned ${response.status}.`, options);
    }
    if (response.status >= 400) {
      return new ProviderError("invalid_request", detail || `${this.name} rejected the request (${response.status}).`, options);
    }
    return new ProviderError("unknown", detail || `${this.name} returned ${response.status}.`, options);
  }
}

/** Provider-neutral messages → OpenAI chat messages. */
export function toOpenAIMessages(messages: ChatMessage[], system?: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "user") {
      const images = message.images ?? [];
      if (images.length === 0) {
        out.push({ role: "user", content: message.content });
        continue;
      }
      out.push({
        role: "user",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } })),
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = message.toolCalls ?? [];
      out.push({
        role: "assistant",
        content: message.content || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }

    out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
    // A tool message cannot carry images in this API, so a screenshot follows
    // as its own user turn rather than being dropped.
    const images = message.images ?? [];
    if (images.length > 0) {
      out.push({
        role: "user",
        content: [
          { type: "text", text: `Images returned by ${message.name}:` },
          ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } })),
        ],
      });
    }
  }

  return out;
}

/** Reads an SSE body, yielding each parsed `data:` payload until `[DONE]`. */
async function* readSseJson(response: Response, signal: AbortSignal | undefined, provider: string): AsyncGenerator<unknown> {
  if (!response.body) throw new ProviderError("unavailable", "The response had no body.", { provider });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      throwIfAborted(signal, provider);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; \r\n appears behind some proxies.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            yield JSON.parse(payload);
          } catch {
            // A malformed frame must not kill a working stream.
            console.warn(`${provider}: dropped an unparsable stream frame`);
          }
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw new ProviderError("aborted", "The request was cancelled.", { provider, cause: error });
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function toToolCallRequest(partial: PartialToolCall, index: number): ToolCallRequest | null {
  if (!partial.name) return null;
  let args: Record<string, unknown> = {};
  const text = partial.arguments.trim();
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      // Leave the arguments empty; the runtime validates against the tool's
      // schema and reports a usable error to the model.
    }
  }
  return { id: partial.id || `call_${index}`, name: partial.name, arguments: args };
}

function toUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): TokenUsage {
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: usage.total_tokens ?? inputTokens + outputTokens };
}

function toFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

/** Pulls the useful sentence out of an error body without leaking the whole payload. */
function extractMessage(text: string): string {
  if (!text) return "";
  try {
    const body: unknown = JSON.parse(text);
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return error.slice(0, 300);
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message.slice(0, 300);
    }
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string") return message.slice(0, 300);
  } catch {
    // Not JSON.
  }
  return text.slice(0, 300);
}

/** `Retry-After` is either seconds or an HTTP date. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function throwIfAborted(signal: AbortSignal | undefined, provider: string): void {
  if (signal?.aborted) throw new ProviderError("aborted", "The request was cancelled.", { provider });
}
