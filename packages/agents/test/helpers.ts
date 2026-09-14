import { randomUUID } from "node:crypto";
import { ProviderRegistry, type ChatRequest, type ChatStreamChunk, type ModelProvider } from "@aiw/ai";
import { createDatabase, schema, type DatabaseHandle } from "@aiw/database";
import { getTestDatabaseUrl } from "@aiw/database/testing";
import { InMemoryTaskEventBus, TaskEventRecorder } from "../src";

export type CallKind = "routing" | "planning" | "step";

export function classify(request: ChatRequest): CallKind {
  if (request.responseFormat && request.system?.includes("task router")) return "routing";
  if (request.responseFormat) return "planning";
  return "step";
}

export type ScriptedReply = string | { text?: string; toolCalls: { name: string; arguments: Record<string, unknown> }[] };
export type Handler = (request: ChatRequest, kind: CallKind) => Promise<ScriptedReply> | ScriptedReply;

/** Deterministic provider driven by a handler; records every request. */
export class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly name = "Scripted";
  readonly defaultModel = "scripted-1";
  readonly requests: { kind: CallKind; request: ChatRequest }[] = [];

  constructor(public handler: Handler) {}

  isConfigured() {
    return true;
  }

  async listModels() {
    return ["scripted-1", "scripted-2"].map((id) => ({
      id,
      label: id,
      provider: this.id,
      inputTokenLimit: null,
      outputTokenLimit: null,
    }));
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const kind = classify(request);
    this.requests.push({ kind, request });
    const reply = await this.handler(request, kind);
    if (typeof reply === "string") {
      yield { type: "text-delta", text: reply };
    } else {
      if (reply.text) yield { type: "text-delta", text: reply.text };
      for (const [index, call] of reply.toolCalls.entries()) {
        yield { type: "tool-call", call: { id: `call_${this.requests.length}_${index}`, name: call.name, arguments: call.arguments, providerMetadata: { thoughtSignature: "sig" } } };
      }
    }
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  }

  calls(kind: CallKind) {
    return this.requests.filter((r) => r.kind === kind);
  }
}

export function registryFor(provider: ModelProvider): ProviderRegistry {
  return new ProviderRegistry([provider], provider.id);
}

/** Records events to the test database and keeps every bus message for assertions. */
export function eventRecorder(handle: DatabaseHandle) {
  const bus = new InMemoryTaskEventBus();
  const events = new TaskEventRecorder(handle.db, bus);
  return { bus, events };
}

export function openTestDatabase(): DatabaseHandle {
  return createDatabase(getTestDatabaseUrl(), { max: 3 });
}

export async function createUser(handle: DatabaseHandle): Promise<string> {
  const id = randomUUID();
  await handle.db.insert(schema.users).values({ id, name: "Tester", email: `${id}@example.test` });
  return id;
}

/** Resolves after `ms`, or rejects when the signal aborts (like a real network call). */
export function waitOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });
}
