"use client";

import type { ConversationWithMessagesDto, MessageAttachment } from "@aiw/shared";
import { AlertCircleIcon, ArrowDownIcon, KeyRoundIcon, XIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAgents } from "../agents/use-agents";
import { ConversationActions } from "../conversations/conversation-actions";
import { useConversations } from "../conversations/conversations-context";
import { AgentPicker, type AgentMode } from "./agent-picker";
import { NO_PROJECT, ProjectPicker } from "./project-picker";
import { Composer, type ComposerHandle } from "./composer";
import { EmptyState } from "./empty-state";
import { MessageItem } from "./message-item";
import { DEFAULT_MODEL_VALUE, ModelPicker } from "./model-picker";
import { useChat } from "./use-chat";
import { useModels } from "./use-models";

const STICK_TO_BOTTOM_PX = 120;
const AGENT_MODE_KEY = "aiw:agent-mode";

function readAgentMode(): AgentMode {
  try {
    return (window.localStorage.getItem(AGENT_MODE_KEY) as AgentMode | null) ?? "auto";
  } catch {
    return "auto";
  }
}

export function ChatView({ conversation }: { conversation: ConversationWithMessagesDto | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { conversations, upsert } = useConversations();
  const models = useModels();
  const { agents } = useAgents();
  const [agentMode, setAgentMode] = useState<AgentMode>("auto");
  const searchParams = useSearchParams();
  const [taskModel, setTaskModel] = useState<string>(DEFAULT_MODEL_VALUE);
  // A project can be preselected by linking to "/?projectId=…" from a project page.
  const [project, setProject] = useState<string>(() => searchParams?.get("projectId") ?? NO_PROJECT);

  useEffect(() => {
    // Restore the last agent choice after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAgentMode(readAgentMode());
  }, []);

  // Fall back to auto-routing if the remembered agent was deleted or disabled.
  const selectedAgent = agents.find((a) => a.id === agentMode);
  const effectiveMode: AgentMode =
    agentMode === "auto" || agentMode === "chat" || selectedAgent?.enabled ? agentMode : "auto";

  function changeAgentMode(mode: AgentMode) {
    setAgentMode(mode);
    try {
      window.localStorage.setItem(AGENT_MODE_KEY, mode);
    } catch {
      // Storage unavailable; keep the in-memory choice.
    }
  }
  const composerRef = useRef<ComposerHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const chat = useChat({
    initialConversationId: conversation?.id ?? null,
    initialMessages: conversation?.messages ?? [],
    onConversationStarted: ({ id, title }) => upsert({ id, title }),
    onActivity: (id) => {
      const existing = conversations.find((c) => c.id === id);
      if (existing) upsert({ ...existing, lastMessageAt: new Date().toISOString() });
    },
    onUnauthorized: () => router.replace("/sign-in"),
  });
  const { reset, conversationId } = chat;

  // Stable callback so memoised messages do not re-render on every streamed token.
  const retryRef = useRef(() => {});
  useEffect(() => {
    retryRef.current = () => void chat.retry(models.selected);
  });
  const onRetry = useCallback(() => retryRef.current(), []);

  // The new-task page swaps its URL to /c/:id once a conversation starts. If the
  // user then navigates back to "/", start fresh.
  useEffect(() => {
    if (!conversation && pathname === "/" && conversationId) reset();
  }, [conversation, pathname, conversationId, reset]);

  function onSend(content: string, attachments: MessageAttachment[]): Promise<boolean> {
    if (effectiveMode === "chat") return chat.send(content, models.selected, attachments);
    // An agent task cannot take pictures, but the files are already in its
    // workspace, so it is told where to find them and can read them itself.
    const listed = attachments.map((a) => `- ${a.path} (${a.mimeType})`).join("\n");
    const prompt = attachments.length > 0 ? `${content}\n\nAttached files, already in the workspace:\n${listed}` : content;
    return chat.startTask({
      prompt,
      agentId: effectiveMode === "auto" ? undefined : effectiveMode,
      model: taskModel === DEFAULT_MODEL_VALUE ? undefined : taskModel,
      projectId: project === NO_PROJECT ? undefined : project,
    });
  }

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useLayoutEffect(() => {
    if (stickToBottom.current) scrollToBottom();
  }, [chat.messages, scrollToBottom]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < STICK_TO_BOTTOM_PX;
    setShowScrollButton(distance > STICK_TO_BOTTOM_PX * 2);
  }

  const sidebarConversation = conversations.find((c) => c.id === conversationId);
  const title = sidebarConversation?.title ?? conversation?.title ?? "New task";
  const hasMessages = chat.messages.length > 0;
  const streaming = chat.status !== "idle";
  const notConfigured = !models.loading && !models.configured;

  const disabledReason = notConfigured
    ? `${models.providerName} is not configured`
    : chat.generatingElsewhere
      ? "Waiting for the current reply or task to finish…"
      : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="hidden h-14 shrink-0 items-center gap-2 border-b px-4 transition-[padding] group-data-[collapsed=true]/shell:pl-24 md:flex lg:px-6 lg:group-data-[collapsed=true]/shell:pl-24">
        <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
        {sidebarConversation && <ConversationActions conversation={sidebarConversation} align="start" />}
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto">
        {hasMessages ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-6 pb-10 sm:px-6">
            {chat.messages.map((message, index) => (
              <MessageItem
                key={message.id}
                message={message}
                isLast={index === chat.messages.length - 1}
                canRetry={!chat.busy && !notConfigured && !!chat.conversationId}
                onRetry={onRetry}
                onMessageChange={chat.patchMessage}
              />
            ))}
            {chat.generatingElsewhere && !chat.messages.at(-1)?.taskId && (
              <p className="text-center text-xs text-muted-foreground">
                A reply is still being generated. It will appear here when it finishes.
              </p>
            )}
          </div>
        ) : (
          <div className="flex min-h-full flex-col">
            <EmptyState onPick={(prompt) => composerRef.current?.setValue(prompt)} />
          </div>
        )}
      </div>

      <div className="relative shrink-0">
        {showScrollButton && hasMessages && (
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Scroll to bottom"
            onClick={() => scrollToBottom("smooth")}
            className="absolute -top-11 left-1/2 z-10 -translate-x-1/2 rounded-full bg-background shadow-md"
          >
            <ArrowDownIcon />
          </Button>
        )}

        {notConfigured && (
          <Notice icon={<KeyRoundIcon className="size-4 text-warning" />}>
            <span className="font-medium">{models.providerName} is not configured.</span> Set{" "}
            <code className="font-mono text-xs">GEMINI_API_KEY</code> in the server environment and restart the app.
          </Notice>
        )}
        {!notConfigured && models.listError && (
          <Notice icon={<AlertCircleIcon className="size-4 text-warning" />}>
            Could not load the model list ({models.listError}). The default model is still available.
          </Notice>
        )}
        {chat.error && (
          <Notice
            icon={<AlertCircleIcon className="size-4 text-destructive" />}
            onDismiss={chat.clearError}
            tone="error"
          >
            {chat.error}
          </Notice>
        )}

        <Composer
          ref={composerRef}
          onSend={onSend}
          onStop={chat.stop}
          streaming={chat.status === "streaming"}
          disabled={notConfigured || chat.generatingElsewhere || chat.status === "submitting"}
          disabledReason={disabledReason}
          placeholder={effectiveMode === "chat" ? "Message the assistant…" : "Give an agent a task…"}
          projectId={effectiveMode !== "chat" && project !== NO_PROJECT ? project : null}
          controls={
            <>
              <AgentPicker agents={agents} value={effectiveMode} onChange={changeAgentMode} disabled={streaming} />
              {effectiveMode !== "chat" && <ProjectPicker value={project} onChange={setProject} disabled={streaming} />}
              {effectiveMode === "chat" ? (
                <ModelPicker models={models.models} value={models.selected} onChange={models.select} disabled={streaming} />
              ) : (
                <ModelPicker
                  models={models.models}
                  value={taskModel}
                  onChange={setTaskModel}
                  disabled={streaming}
                  defaultLabel="Agent's model"
                />
              )}
            </>
          }
        />
      </div>
    </div>
  );
}

function Notice({
  icon,
  children,
  onDismiss,
  tone = "warning",
}: {
  icon: ReactNode;
  children: ReactNode;
  onDismiss?: () => void;
  tone?: "warning" | "error";
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-2 sm:px-6">
      <div
        role={tone === "error" ? "alert" : "status"}
        className={
          tone === "error"
            ? "flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm"
            : "flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm"
        }
      >
        <span className="mt-0.5">{icon}</span>
        <p className="flex-1 leading-5">{children}</p>
        {onDismiss && (
          <button type="button" onClick={onDismiss} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground">
            <XIcon className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
