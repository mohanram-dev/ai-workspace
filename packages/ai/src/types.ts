/** A function/tool call requested by the model. */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Opaque provider data that must be sent back with the call on the next turn
   * (for example Gemini thought signatures, without which the API rejects the request).
   */
  providerMetadata?: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; content: string; images?: ImageAttachment[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; images?: ImageAttachment[] };

/** An image the model looks at: a tool screenshot, or a picture the user attached. */
export interface ImageAttachment {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  /** Base64 data. */
  data: string;
}

/** A tool the model may call, described with a JSON Schema for its arguments. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Constrain output to JSON matching a JSON Schema (structured output). */
  responseFormat?: { type: "json"; schema: Record<string, unknown> };
  /** Tools the model may call. Not combinable with `responseFormat`. */
  tools?: ToolDeclaration[];
  /** "none" keeps tools declared (required when history has tool calls) but forbids new calls. */
  toolChoice?: "auto" | "none";
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type FinishReason = "stop" | "length" | "content_filter" | "tool_calls" | "other";

export type ChatStreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: ToolCallRequest }
  | { type: "finish"; finishReason: FinishReason; usage: TokenUsage };

/** Result of consuming a full (non-streamed) model response. */
export interface CompletedResponse {
  text: string;
  toolCalls: ToolCallRequest[];
  finishReason: FinishReason;
  usage: TokenUsage;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
}

/**
 * A model backend (Gemini, OpenAI-compatible, Ollama, ...). Implementations
 * translate the provider-neutral request into the vendor API and normalise
 * the streamed response, tool calls, usage and errors.
 */
export interface ModelProvider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  isConfigured(): boolean;
  listModels(): Promise<ModelInfo[]>;
  streamChat(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
}

export interface WebSearchSource {
  title: string;
  url: string;
  snippet: string | null;
}

export interface GroundedSearchResult {
  answer: string;
  sources: WebSearchSource[];
  queries: string[];
  usage: TokenUsage;
  model: string;
}
