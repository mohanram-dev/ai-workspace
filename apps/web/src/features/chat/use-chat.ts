"use client";

import {
  chatStreamEventSchema,
  parseSseStream,
  type ChatStreamEvent,
  type MessageAttachment,
  type MessageDto,
  type SendChatMessageInput,
} from "@aiw/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, errorMessage, toApiClientError } from "@/lib/api-client";
import { fetchConversation } from "../conversations/api";
import { createTask } from "../tasks/api";

export type ChatStatus = "idle" | "submitting" | "streaming";

interface UseChatOptions {
  initialConversationId: string | null;
  initialMessages: MessageDto[];
  onConversationStarted: (conversation: { id: string; title: string }) => void;
  onActivity: (conversationId: string) => void;
  onUnauthorized: () => void;
}

const POLL_INTERVAL_MS = 2000;

function tempId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function localMessage(role: MessageDto["role"], content: string, status: MessageDto["status"], attachments: MessageAttachment[] = []): MessageDto {
  return {
    id: tempId(role),
    taskId: null,
    role,
    content,
    status,
    provider: null,
    model: null,
    error: null,
    inputTokens: null,
    outputTokens: null,
    attachments,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Chat state machine: optimistic messages, SSE streaming from POST /api/chat,
 * stop/retry, and polling for replies that are generating elsewhere.
 */
export function useChat(options: UseChatOptions) {
  const [conversationId, setConversationId] = useState(options.initialConversationId);
  const [messages, setMessages] = useState<MessageDto[]>(options.initialMessages);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const callbacks = useRef(options);

  useEffect(() => {
    callbacks.current = options;
  });

  const patchMessage = useCallback((id: string, patch: (message: MessageDto) => MessageDto) => {
    setMessages((current) => current.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  const runStream = useCallback(
    async (input: SendChatMessageInput, assistantTempId: string, userTempId: string | null, snapshot: MessageDto[]) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("submitting");
      setError(null);

      let assistantId = assistantTempId;
      let pendingText = "";
      let frame = 0;
      let terminal = false;

      const flush = () => {
        frame = 0;
        if (!pendingText) return;
        const text = pendingText;
        pendingText = "";
        patchMessage(assistantId, (m) => ({ ...m, content: m.content + text }));
      };

      const apply = (event: ChatStreamEvent) => {
        switch (event.type) {
          case "start": {
            const { conversationId: id } = event;
            setMessages((current) =>
              current.map((m) => {
                if (m.id === assistantTempId) return { ...m, id: event.assistantMessageId, provider: event.provider, model: event.model };
                if (userTempId && m.id === userTempId && event.userMessageId) return { ...m, id: event.userMessageId };
                return m;
              }),
            );
            assistantId = event.assistantMessageId;
            setStatus("streaming");
            if (!input.conversationId) {
              setConversationId(id);
              window.history.replaceState(null, "", `/c/${id}`);
              callbacks.current.onConversationStarted({ id, title: event.conversationTitle });
            } else {
              callbacks.current.onActivity(id);
            }
            break;
          }
          case "delta":
            pendingText += event.text;
            if (!frame) frame = requestAnimationFrame(flush);
            break;
          case "done":
            terminal = true;
            cancelAnimationFrame(frame);
            flush();
            patchMessage(assistantId, (m) => ({
              ...m,
              status: event.status,
              inputTokens: event.usage.inputTokens || null,
              outputTokens: event.usage.outputTokens || null,
            }));
            break;
          case "error":
            terminal = true;
            cancelAnimationFrame(frame);
            flush();
            patchMessage(assistantId, (m) => ({ ...m, status: "failed", error: event.message }));
            break;
        }
      };

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const apiError = await toApiClientError(response);
          if (apiError.status === 401) callbacks.current.onUnauthorized();
          setMessages(snapshot);
          setError(apiError.message);
          return false;
        }

        for await (const raw of parseSseStream(response.body)) {
          const parsed = chatStreamEventSchema.safeParse(raw);
          if (parsed.success) apply(parsed.data);
        }

        if (!terminal) {
          flush();
          patchMessage(assistantId, (m) => ({ ...m, status: "failed", error: "The response ended unexpectedly." }));
        }
        return true;
      } catch (e) {
        cancelAnimationFrame(frame);
        flush();
        if (controller.signal.aborted) {
          patchMessage(assistantId, (m) => (m.status === "streaming" ? { ...m, status: "cancelled" } : m));
          return true;
        }
        if (assistantId === assistantTempId) {
          // Failed before the server accepted the request.
          setMessages(snapshot);
          setError("Could not reach the server. Check your connection and try again.");
          return false;
        }
        patchMessage(assistantId, (m) => ({
          ...m,
          status: "failed",
          error: "Connection lost. The reply may still finish on the server — reopen the conversation to check.",
        }));
        console.error(e);
        return true;
      } finally {
        abortRef.current = null;
        setStatus("idle");
      }
    },
    [patchMessage],
  );

  const send = useCallback(
    async (content: string, model: string | undefined, attachments: MessageAttachment[] = []): Promise<boolean> => {
      if (abortRef.current) return false;
      const snapshot = messages;
      const user = localMessage("user", content, "completed", attachments);
      const assistant = localMessage("assistant", "", "streaming");
      setMessages([...snapshot, user, assistant]);
      return runStream(
        {
          action: "send",
          content,
          ...(conversationId ? { conversationId } : {}),
          ...(model ? { model } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        assistant.id,
        user.id,
        snapshot,
      );
    },
    [conversationId, messages, runStream],
  );

  const retry = useCallback(
    async (model: string | undefined): Promise<void> => {
      if (abortRef.current || !conversationId) return;
      const snapshot = messages;
      const base = snapshot.at(-1)?.role === "assistant" ? snapshot.slice(0, -1) : snapshot;
      const assistant = localMessage("assistant", "", "streaming");
      setMessages([...base, assistant]);
      await runStream({ action: "retry", conversationId, ...(model ? { model } : {}) }, assistant.id, null, snapshot);
    },
    [conversationId, messages, runStream],
  );

  /** Creates an agent task; its progress is rendered by the task reply component. */
  const startTask = useCallback(
    async (input: { prompt: string; agentId?: string | undefined; model?: string | undefined; projectId?: string | undefined }): Promise<boolean> => {
      if (abortRef.current || status !== "idle") return false;
      setStatus("submitting");
      setError(null);
      const optimistic = localMessage("user", input.prompt, "completed");
      setMessages((current) => [...current, optimistic]);
      try {
        const created = await createTask({
          prompt: input.prompt,
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
        });
        setMessages((current) => [
          ...current.filter((m) => m.id !== optimistic.id),
          created.userMessage,
          created.assistantMessage,
        ]);
        if (!conversationId) {
          setConversationId(created.conversationId);
          window.history.replaceState(null, "", `/c/${created.conversationId}`);
          callbacks.current.onConversationStarted({ id: created.conversationId, title: created.conversationTitle });
        } else {
          callbacks.current.onActivity(created.conversationId);
        }
        return true;
      } catch (e) {
        setMessages((current) => current.filter((m) => m.id !== optimistic.id));
        if (e instanceof ApiClientError && e.status === 401) callbacks.current.onUnauthorized();
        setError(errorMessage(e));
        return false;
      } finally {
        setStatus("idle");
      }
    },
    [conversationId, status],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setConversationId(null);
    setMessages([]);
    setError(null);
  }, []);

  // A reply may be generating from another tab or a request that outlived a
  // navigation. Poll until it settles so the final answer appears.
  const lastMessage = messages.at(-1);
  const generatingElsewhere = status === "idle" && lastMessage?.status === "streaming" && !!conversationId;
  // Task replies poll their task instead of the whole conversation.
  const pollConversation = generatingElsewhere && !lastMessage?.taskId;

  useEffect(() => {
    if (!pollConversation || !conversationId) return;
    const timer = window.setInterval(async () => {
      try {
        const latest = await fetchConversation(conversationId);
        if (latest.messages.at(-1)?.status !== "streaming") setMessages(latest.messages);
      } catch {
        // Keep polling; transient failures are expected while offline.
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pollConversation, conversationId]);

  return {
    conversationId,
    messages,
    status,
    error,
    generatingElsewhere,
    busy: status !== "idle" || generatingElsewhere,
    clearError: () => setError(null),
    send,
    startTask,
    retry,
    stop,
    patchMessage,
    reset,
  };
}
