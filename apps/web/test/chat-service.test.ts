import { randomUUID } from "node:crypto";
import {
  ProviderError,
  ProviderRegistry,
  type ChatRequest,
  type ChatStreamChunk,
  type ModelProvider,
} from "@aiw/ai";
import { createDatabase, listMessages, schema, type DatabaseHandle } from "@aiw/database";
import { getTestDatabaseUrl } from "@aiw/database/testing";
import type { ChatStreamEvent } from "@aiw/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeChatTurn, prepareChatTurn, type ChatServiceDeps } from "@/server/chat/chat-service";
import { HttpError } from "@/server/http";

type Script = (request: ChatRequest) => AsyncGenerator<ChatStreamChunk>;

/** Deterministic in-memory provider that records every request it receives. */
class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly name = "Scripted";
  readonly defaultModel = "scripted-1";
  readonly requests: ChatRequest[] = [];
  configured = true;
  script: Script = async function* () {
    yield { type: "text-delta", text: "Hello" };
    yield { type: "text-delta", text: " there" };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } };
  };

  isConfigured() {
    return this.configured;
  }
  async listModels() {
    return [{ id: "scripted-1", label: "Scripted", provider: this.id, inputTokenLimit: null, outputTokenLimit: null }];
  }
  streamChat(request: ChatRequest) {
    this.requests.push(request);
    return this.script(request);
  }
}

let handle: DatabaseHandle;

beforeAll(() => {
  handle = createDatabase(getTestDatabaseUrl(), { max: 2 });
});

afterAll(async () => {
  await handle.close();
});

function setup() {
  const provider = new ScriptedProvider();
  const deps: ChatServiceDeps = {
    db: handle.db,
    registry: new ProviderRegistry([provider], provider.id),
    systemPrompt: "system prompt",
  };
  return { provider, deps };
}

async function createUser(): Promise<string> {
  const id = randomUUID();
  await handle.db.insert(schema.users).values({ id, name: "Tester", email: `${id}@example.test` });
  return id;
}

async function run(deps: ChatServiceDeps, turn: Awaited<ReturnType<typeof prepareChatTurn>>, signal = new AbortController().signal) {
  const events: ChatStreamEvent[] = [];
  for await (const event of executeChatTurn(deps, turn, signal)) events.push(event);
  return events;
}

async function usageFor(messageId: string) {
  return handle.db.select().from(schema.usageLogs).where(eq(schema.usageLogs.messageId, messageId));
}

describe("chat service", () => {
  it("creates a conversation, streams the reply and persists message + usage", async () => {
    const { deps, provider } = setup();
    const userId = await createUser();

    const turn = await prepareChatTurn(deps, userId, {
      action: "send",
      content: "Explain Docker volumes in one line",
    });
    const events = await run(deps, turn);

    expect(events.map((e) => e.type)).toEqual(["start", "delta", "delta", "done"]);
    expect(events[0]).toMatchObject({
      conversationId: turn.conversation.id,
      conversationTitle: "Explain Docker volumes in one line",
      provider: "scripted",
      model: "scripted-1",
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "completed",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      estimatedCostUsd: null,
    });

    expect(provider.requests[0]).toMatchObject({
      model: "scripted-1",
      system: "system prompt",
      messages: [{ role: "user", content: "Explain Docker volumes in one line" }],
    });

    const messages = await listMessages(handle.db, turn.conversation.id);
    expect(messages.map((m) => [m.role, m.status, m.content])).toEqual([
      ["user", "completed", "Explain Docker volumes in one line"],
      ["assistant", "completed", "Hello there"],
    ]);
    expect(messages[1]).toMatchObject({ inputTokens: 10, outputTokens: 4, finishReason: "stop" });

    const usage = await usageFor(turn.assistantMessage.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ userId, totalTokens: 14, status: "completed", provider: "scripted" });
  });

  it("continues an existing conversation with full history", async () => {
    const { deps, provider } = setup();
    const userId = await createUser();
    const first = await prepareChatTurn(deps, userId, { action: "send", content: "First" });
    await run(deps, first);

    const second = await prepareChatTurn(deps, userId, {
      action: "send",
      conversationId: first.conversation.id,
      content: "Second",
    });
    await run(deps, second);

    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "Hello there" },
      { role: "user", content: "Second" },
    ]);
  });

  it("records provider failures with partial output and a safe error message", async () => {
    const { deps, provider } = setup();
    provider.script = async function* () {
      yield { type: "text-delta", text: "Partial" };
      throw new ProviderError("rate_limited", "Gemini rate limit or quota exceeded. Try again shortly.", {
        provider: "scripted",
        status: 429,
      });
    };
    const userId = await createUser();
    const turn = await prepareChatTurn(deps, userId, { action: "send", content: "Hi" });
    const events = await run(deps, turn);

    expect(events.at(-1)).toEqual({
      type: "error",
      code: "rate_limited",
      message: "Gemini rate limit or quota exceeded. Try again shortly.",
      retryable: true,
    });
    const [, assistant] = await listMessages(handle.db, turn.conversation.id);
    expect(assistant).toMatchObject({ status: "failed", content: "Partial", finishReason: "error" });
    expect(assistant?.error).toContain("rate limit");
    expect((await usageFor(turn.assistantMessage.id))[0]?.status).toBe("failed");
  });

  it("hides unexpected internal errors from the client", async () => {
    const { deps, provider } = setup();
    provider.script = async function* () {
      throw new Error("connection string postgres://secret@internal");
    };
    const userId = await createUser();
    const turn = await prepareChatTurn(deps, userId, { action: "send", content: "Hi" });
    const originalError = console.error;
    console.error = () => {};
    try {
      const events = await run(deps, turn);
      const last = events.at(-1);
      expect(last).toMatchObject({ type: "error", code: "unknown" });
      expect(JSON.stringify(events)).not.toContain("secret");
    } finally {
      console.error = originalError;
    }
  });

  it("marks the reply cancelled when the signal aborts mid-stream", async () => {
    const { deps, provider } = setup();
    const controller = new AbortController();
    provider.script = async function* (request) {
      yield { type: "text-delta", text: "Start" };
      controller.abort();
      if (request.signal?.aborted) {
        throw new ProviderError("aborted", "The request was cancelled.", { provider: "scripted" });
      }
      yield { type: "text-delta", text: "never" };
    };
    const userId = await createUser();
    const turn = await prepareChatTurn(deps, userId, { action: "send", content: "Hi" });
    const events = await run(deps, turn, controller.signal);

    expect(events.at(-1)).toMatchObject({ type: "done", status: "cancelled", estimatedCostUsd: null });
    const [, assistant] = await listMessages(handle.db, turn.conversation.id);
    expect(assistant).toMatchObject({ status: "cancelled", content: "Start" });
    expect((await usageFor(turn.assistantMessage.id))[0]?.estimatedCostUsd).toBeNull();
  });

  it("retry replaces the last assistant reply", async () => {
    const { deps, provider } = setup();
    const userId = await createUser();
    const first = await prepareChatTurn(deps, userId, { action: "send", content: "Question" });
    await run(deps, first);

    provider.script = async function* () {
      yield { type: "text-delta", text: "Better answer" };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    };
    const retry = await prepareChatTurn(deps, userId, { action: "retry", conversationId: first.conversation.id });
    const events = await run(deps, retry);

    expect(events[0]).toMatchObject({ type: "start", userMessageId: null });
    expect(provider.requests[1]?.messages).toEqual([{ role: "user", content: "Question" }]);
    const messages = await listMessages(handle.db, first.conversation.id);
    expect(messages.map((m) => m.content)).toEqual(["Question", "Better answer"]);
  });

  it("excludes failed assistant output from later context", async () => {
    const { deps, provider } = setup();
    provider.script = async function* () {
      yield { type: "text-delta", text: "broken half-answer" };
      throw new ProviderError("unavailable", "Gemini is temporarily unavailable.", { provider: "scripted" });
    };
    const userId = await createUser();
    const failed = await prepareChatTurn(deps, userId, { action: "send", content: "One" });
    await run(deps, failed);

    provider.script = new ScriptedProvider().script;
    const next = await prepareChatTurn(deps, userId, {
      action: "send",
      conversationId: failed.conversation.id,
      content: "Two",
    });
    await run(deps, next);
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "One" },
      { role: "user", content: "Two" },
    ]);
  });

  it("rejects access to another user's conversation", async () => {
    const { deps } = setup();
    const owner = await createUser();
    const intruder = await createUser();
    const turn = await prepareChatTurn(deps, owner, { action: "send", content: "private" });
    await run(deps, turn);

    for (const input of [
      { action: "send" as const, conversationId: turn.conversation.id, content: "hi" },
      { action: "retry" as const, conversationId: turn.conversation.id },
    ]) {
      const error = await prepareChatTurn(deps, intruder, input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 404 });
    }
    expect(await listMessages(handle.db, turn.conversation.id)).toHaveLength(2);
  });

  it("rejects a second message while a reply is still streaming", async () => {
    const { deps } = setup();
    const userId = await createUser();
    const turn = await prepareChatTurn(deps, userId, { action: "send", content: "Hi" });
    // Not executed yet: assistant placeholder is still `streaming`.
    const error = await prepareChatTurn(deps, userId, {
      action: "send",
      conversationId: turn.conversation.id,
      content: "Again",
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 409, code: "conflict" });
  });

  it("does not let direct chat interfere with agent task replies", async () => {
    const { deps } = setup();
    const userId = await createUser();
    const turn = await prepareChatTurn(deps, userId, { action: "send", content: "Hi" });
    await run(deps, turn);

    const [task] = await handle.db
      .insert(schema.tasks)
      .values({ userId, conversationId: turn.conversation.id, prompt: "Agent job", status: "running" })
      .returning();
    // Inserted separately so the rows get distinct timestamps and a stable order.
    await handle.db.insert(schema.messages).values({ conversationId: turn.conversation.id, role: "user", content: "Agent job" });
    await handle.db
      .insert(schema.messages)
      .values({ conversationId: turn.conversation.id, role: "assistant", taskId: task!.id, status: "streaming" });

    await expect(
      prepareChatTurn(deps, userId, { action: "send", conversationId: turn.conversation.id, content: "More" }),
    ).rejects.toMatchObject({ status: 409 });

    await handle.db.update(schema.tasks).set({ status: "completed" }).where(eq(schema.tasks.id, task!.id));
    await handle.db.update(schema.messages).set({ status: "completed" }).where(eq(schema.messages.taskId, task!.id));
    await expect(
      prepareChatTurn(deps, userId, { action: "retry", conversationId: turn.conversation.id }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await listMessages(handle.db, turn.conversation.id)).toHaveLength(4);
  });

  it("fails before writing anything when the provider is not configured", async () => {
    const { deps, provider } = setup();
    provider.configured = false;
    const userId = await createUser();

    await expect(prepareChatTurn(deps, userId, { action: "send", content: "Hi" })).rejects.toMatchObject({
      code: "not_configured",
    });
    const conversations = await handle.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.userId, userId));
    expect(conversations).toEqual([]);
  });

  it("rejects unknown models", async () => {
    const { deps } = setup();
    const userId = await createUser();
    await expect(
      prepareChatTurn(deps, userId, { action: "send", content: "Hi", model: "not-a-model" }),
    ).rejects.toMatchObject({ code: "model_not_found" });
  });
});
