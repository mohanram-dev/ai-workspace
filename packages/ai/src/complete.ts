import type { ChatRequest, CompletedResponse, ModelProvider, ToolCallRequest } from "./types";

/** Runs a request to completion and returns the full text, tool calls and usage. */
export async function completeChat(provider: ModelProvider, request: ChatRequest): Promise<CompletedResponse> {
  let text = "";
  const toolCalls: ToolCallRequest[] = [];
  let result: Pick<CompletedResponse, "finishReason" | "usage"> = {
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
  for await (const chunk of provider.streamChat(request)) {
    if (chunk.type === "text-delta") text += chunk.text;
    else if (chunk.type === "tool-call") toolCalls.push(chunk.call);
    else result = { finishReason: chunk.finishReason, usage: chunk.usage };
  }
  return { text, toolCalls, ...result };
}
