import type { Message } from "@aiw/database";
import { describe, expect, it } from "vitest";
import { STALE_STREAM_MS, toMessageDto } from "./dto";

function message(overrides: Partial<Message>): Message {
  return {
    id: "3f1f8f5e-2b8e-4a53-9c4f-4a5b7e1f2d3c",
    conversationId: "c",
    taskId: null,
    role: "assistant",
    content: "partial",
    status: "streaming",
    provider: "gemini",
    model: "m",
    error: null,
    finishReason: null,
    inputTokens: null,
    outputTokens: null,
    attachments: null,
    createdAt: new Date(0),
    completedAt: null,
    ...overrides,
  };
}

describe("toMessageDto", () => {
  it("reports long-running streaming messages as interrupted", () => {
    const dto = toMessageDto(message({}), STALE_STREAM_MS + 1);
    expect(dto).toMatchObject({ status: "failed", error: "Generation was interrupted before it finished." });
  });

  it("leaves agent task replies to the task status", () => {
    expect(toMessageDto(message({ taskId: "t" }), STALE_STREAM_MS + 1).status).toBe("streaming");
  });

  it("keeps in-flight streams as streaming", () => {
    expect(toMessageDto(message({}), 1000).status).toBe("streaming");
  });
});
