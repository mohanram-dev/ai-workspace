"use client";

import type { MessageDto } from "@aiw/shared";
import { AlertTriangleIcon, CheckIcon, CopyIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TaskReply } from "../tasks/task-reply";
import { Markdown } from "./markdown";
import { useCopy } from "./use-copy";
import { AttachmentChips } from "./attachment-picker";

interface MessageItemProps {
  message: MessageDto;
  isLast: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onMessageChange: (id: string, patch: (message: MessageDto) => MessageDto) => void;
}

export const MessageItem = memo(function MessageItem({ message, isLast, canRetry, onRetry, onMessageChange }: MessageItemProps) {
  if (message.role === "user") return <UserMessage message={message} />;
  if (message.taskId) return <TaskMessage message={message} onMessageChange={onMessageChange} />;
  return <AssistantMessage message={message} isLast={isLast} canRetry={canRetry} onRetry={onRetry} />;
});

function TaskMessage({ message, onMessageChange }: Pick<MessageItemProps, "message" | "onMessageChange">) {
  const onChange = useCallback(
    (patch: Partial<MessageDto>) => onMessageChange(message.id, (m) => ({ ...m, ...patch })),
    [message.id, onMessageChange],
  );
  return (
    <div className="flex gap-3">
      <LogoMark className="mt-0.5 size-7" />
      <div className="min-w-0 flex-1">
        <TaskReply key={message.taskId} taskId={message.taskId!} onMessageChange={onChange} />
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: MessageDto }) {
  const { copied, copy } = useCopy();
  return (
    <div className="group/msg flex flex-col items-end gap-1">
      {message.attachments.length > 0 && (
        <div className="max-w-[88%] sm:max-w-[75%]">
          <AttachmentChips attachments={message.attachments} />
        </div>
      )}
      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[0.9375rem] leading-7 whitespace-pre-wrap break-words text-secondary-foreground sm:max-w-[75%]">
        {message.content}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => copy(message.content)}
        aria-label="Copy message"
        className="text-muted-foreground opacity-100 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100 md:opacity-0"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

function AssistantMessage({ message, isLast, canRetry, onRetry }: Omit<MessageItemProps, "onMessageChange">) {
  const { copied, copy } = useCopy();
  const streaming = message.status === "streaming";
  const hasContent = message.content.length > 0;

  return (
    <div className="group/msg flex gap-3">
      <LogoMark className="mt-0.5 size-7" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex h-7 items-center gap-2 text-sm">
          <span className="font-medium">Assistant</span>
          {message.model && <span className="truncate font-mono text-xs text-muted-foreground">{message.model}</span>}
        </div>

        {hasContent && <Markdown content={message.content} />}

        {streaming && !hasContent && <ThinkingIndicator />}
        {streaming && hasContent && (
          <span aria-hidden className="mt-1 inline-block size-2 animate-pulse rounded-full bg-brand" />
        )}

        {message.status === "cancelled" && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <SquareIcon className="size-3" /> Stopped{hasContent ? "" : " before any output"}
          </p>
        )}

        {message.status === "failed" && (
          <div role="alert" className="mt-3 flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 sm:flex-row sm:items-center">
            <AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
            <div className="flex-1 text-sm">
              <p className="font-medium">The response failed</p>
              <p className="text-muted-foreground">{message.error ?? "Something went wrong."}</p>
            </div>
            {isLast && canRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCcwIcon /> Retry
              </Button>
            )}
          </div>
        )}

        {!streaming && (
          <div className="mt-1.5 flex items-center gap-0.5 text-muted-foreground opacity-100 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 md:opacity-0 data-[last=true]:opacity-100" data-last={isLast}>
            {hasContent && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" onClick={() => copy(message.content)} aria-label="Copy response">
                    {copied ? <CheckIcon /> : <CopyIcon />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy</TooltipContent>
              </Tooltip>
            )}
            {isLast && canRetry && message.status !== "failed" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" onClick={onRetry} aria-label="Regenerate response">
                    <RotateCcwIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Regenerate</TooltipContent>
              </Tooltip>
            )}
            {Boolean(message.inputTokens || message.outputTokens) && (
              <span className="ml-1.5 font-mono text-[0.7rem] tabular-nums">
                {message.inputTokens ?? 0} in · {message.outputTokens ?? 0} out
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex h-7 items-center gap-1" aria-label="Generating response" role="status">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className={cn("size-1.5 animate-bounce rounded-full bg-muted-foreground/60")}
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}
