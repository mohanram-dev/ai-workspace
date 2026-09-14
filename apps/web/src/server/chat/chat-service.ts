import {
  estimateCostUsd,
  isProviderError,
  type ChatMessage,
  type ModelProvider,
  type ProviderRegistry,
  type TokenUsage,
} from "@aiw/ai";
import {
  createConversation,
  deleteMessage,
  getConversationForUser,
  insertMessage,
  insertUsageLog,
  listMessages,
  touchConversation,
  updateMessage,
  type Conversation,
  type Database,
  type Message,
} from "@aiw/database";
import { assertConversationIdle } from "@aiw/agents";
import { deriveConversationTitle, type ChatStreamEvent, type SendChatMessageInput } from "@aiw/shared";
import { HttpError } from "../http";
import { prepareAttachments, type PreparedAttachments } from "./attachments";

/** Maximum prior messages sent to the model as context. */
const MAX_HISTORY_MESSAGES = 50;

export interface ChatServiceDeps {
  db: Database;
  registry: ProviderRegistry;
  systemPrompt: string;
}

export interface PreparedChatTurn {
  userId: string;
  conversation: Conversation;
  userMessage: Message | null;
  assistantMessage: Message;
  history: ChatMessage[];
  provider: ModelProvider;
  model: string;
}

/**
 * Validates the request and persists the user message plus an assistant
 * placeholder. Throws HttpError/ProviderError before anything is streamed so
 * the route can answer with a proper HTTP status.
 */
export async function prepareChatTurn(
  deps: ChatServiceDeps,
  userId: string,
  input: SendChatMessageInput,
): Promise<PreparedChatTurn> {
  const { db } = deps;
  // Resolve first: an unconfigured provider or unknown model must not create rows.
  const { provider, model } = await deps.registry.resolveModel(input.model);

  let conversation: Conversation;
  let userMessage: Message | null = null;
  let prepared: PreparedAttachments | null = null;

  if (input.conversationId) {
    const existing = await getConversationForUser(db, userId, input.conversationId);
    if (!existing) throw new HttpError(404, "not_found", "Conversation not found.");
    conversation = existing;
  } else if (input.action === "send") {
    conversation = await createConversation(db, {
      userId,
      title: deriveConversationTitle(input.content),
    });
  } else {
    throw new HttpError(400, "bad_request", "conversationId is required.");
  }

  const existingMessages = await listMessages(db, conversation.id);
  await assertConversationIdle(db, userId, existingMessages);
  const last = existingMessages.at(-1);

  let historySource = existingMessages;
  if (input.action === "send") {
    const attachments = input.attachments ?? [];
    // Read the files before the message is stored, so a bad attachment fails
    // the request instead of leaving a message nobody can answer.
    prepared = attachments.length > 0 ? await prepareAttachments(userId, attachments) : null;
    userMessage = await insertMessage(db, {
      conversationId: conversation.id,
      role: "user",
      content: input.content,
      status: "completed",
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    historySource = [...existingMessages, userMessage];
  } else {
    if (last?.taskId) {
      throw new HttpError(400, "bad_request", "This reply was produced by an agent task. Retry the task instead.");
    }
    if (last?.role === "assistant") {
      await deleteMessage(db, last.id);
      historySource = existingMessages.slice(0, -1);
    }
    if (!historySource.some((m) => m.role === "user")) {
      throw new HttpError(400, "bad_request", "There is no message to retry.");
    }
  }

  const history = historySource
    .filter((m): m is Message & { role: "user" | "assistant" } => m.role !== "system")
    .filter((m) => m.content.length > 0 && (m.role === "user" || m.status !== "failed"))
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m): ChatMessage => ({ role: m.role, content: m.content }));

  // The newest user turn carries this request's attachments: file text is
  // appended to what they typed, and images are sent for the model to look at.
  const lastTurn = history.at(-1);
  if (prepared && lastTurn?.role === "user") {
    if (prepared.text) lastTurn.content = `${lastTurn.content}

${prepared.text}`;
    if (prepared.images.length > 0) lastTurn.images = prepared.images;
  }

  const assistantMessage = await insertMessage(db, {
    conversationId: conversation.id,
    role: "assistant",
    content: "",
    status: "streaming",
    provider: provider.id,
    model,
  });
  await touchConversation(db, conversation.id);

  return { userId, conversation, userMessage, assistantMessage, history, provider, model };
}

/**
 * Streams the model response as typed events and persists the outcome.
 * Always runs to completion: cancellation is signalled through `signal`, and
 * the final message state and usage log are written before returning.
 */
export async function* executeChatTurn(
  deps: ChatServiceDeps,
  turn: PreparedChatTurn,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  yield {
    type: "start",
    conversationId: turn.conversation.id,
    conversationTitle: turn.conversation.title,
    userMessageId: turn.userMessage?.id ?? null,
    assistantMessageId: turn.assistantMessage.id,
    provider: turn.provider.id,
    model: turn.model,
  };

  const startedAt = performance.now();
  let content = "";
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let finishReason = "unknown";
  let status: "completed" | "cancelled" | "failed" = "completed";
  let failure: { code: string; message: string; retryable: boolean } | null = null;

  try {
    const stream = turn.provider.streamChat({
      model: turn.model,
      system: deps.systemPrompt,
      messages: turn.history,
      signal,
    });
    for await (const chunk of stream) {
      if (chunk.type === "text-delta") {
        content += chunk.text;
        yield { type: "delta", text: chunk.text };
      } else if (chunk.type === "finish") {
        usage = chunk.usage;
        finishReason = chunk.finishReason;
      }
    }
  } catch (error) {
    if (signal.aborted || (isProviderError(error) && error.code === "aborted")) {
      status = "cancelled";
      finishReason = "cancelled";
    } else {
      status = "failed";
      finishReason = "error";
      failure = isProviderError(error)
        ? { code: error.code, message: error.message, retryable: error.retryable }
        : { code: "unknown", message: "The response failed unexpectedly.", retryable: true };
      if (!isProviderError(error)) console.error("Chat stream failed", error);
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);
  // Providers report usage only at the end of a stream. Without it (stopped or
  // failed replies) the cost is unknown, not zero.
  const estimatedCostUsd =
    usage.totalTokens > 0 ? estimateCostUsd(turn.provider.id, turn.model, usage) : null;

  await updateMessage(deps.db, turn.assistantMessage.id, {
    content,
    status,
    error: failure?.message ?? null,
    finishReason,
    inputTokens: usage.inputTokens || null,
    outputTokens: usage.outputTokens || null,
    completedAt: new Date(),
  });
  await insertUsageLog(deps.db, {
    userId: turn.userId,
    conversationId: turn.conversation.id,
    messageId: turn.assistantMessage.id,
    provider: turn.provider.id,
    model: turn.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd,
    durationMs,
    status,
  });
  await touchConversation(deps.db, turn.conversation.id);

  if (failure) {
    yield { type: "error", ...failure };
  } else {
    yield {
      type: "done",
      status: status === "cancelled" ? "cancelled" : "completed",
      finishReason,
      usage,
      estimatedCostUsd,
      durationMs,
    };
  }
}
