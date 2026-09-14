"use client";

import { MAX_MESSAGE_LENGTH, type MessageAttachment } from "@aiw/shared";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AttachmentChips, AttachmentPicker } from "./attachment-picker";

export interface ComposerHandle {
  setValue: (value: string) => void;
  focus: () => void;
}

interface ComposerProps {
  onSend: (content: string, attachments: MessageAttachment[]) => Promise<boolean>;
  /** Project whose workspace receives attachments; null for the personal one. */
  projectId?: string | null | undefined;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  disabledReason?: string | undefined;
  /** Pickers shown in the toolbar (agent, model). */
  controls?: ReactNode;
  placeholder?: string;
  ref?: Ref<ComposerHandle>;
}

const MAX_HEIGHT_PX = 240;

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  disabledReason,
  controls,
  placeholder,
  projectId,
  ref,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    setValue: (next) => {
      setValue(next);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    focus: () => textareaRef.current?.focus(),
  }));

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const trimmed = value.trim();
  const tooLong = value.length > MAX_MESSAGE_LENGTH;
  const canSend = !disabled && !streaming && trimmed.length > 0 && !tooLong;

  async function submit() {
    if (!canSend) return;
    const content = trimmed;
    const sent = attachments;
    setValue("");
    setAttachments([]);
    const accepted = await onSend(content, sent);
    // Restore the draft if the server rejected the message.
    if (!accepted) {
      setValue((current) => current || content);
      setAttachments((current) => (current.length ? current : sent));
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-6 sm:pb-4">
      <form
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className={cn(
          "rounded-2xl border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)] transition-colors focus-within:border-ring/60 dark:shadow-none",
          disabled && "opacity-80",
        )}
      >
        {attachments.length > 0 && (
          <div className="px-3 pt-3">
            <AttachmentChips attachments={attachments} onRemove={(index) => setAttachments((current) => current.filter((_, i) => i !== index))} />
          </div>
        )}
        <label htmlFor="composer-input" className="sr-only">
          Describe a task
        </label>
        <textarea
          id="composer-input"
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={disabled}
          placeholder={disabledReason ?? placeholder ?? "Give the assistant a task…"}
          className="scrollbar-thin block max-h-60 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[0.9375rem] leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />

        <div className="flex items-center gap-1 px-2 pt-1 pb-2">
          <AttachmentPicker attachments={attachments} onChange={setAttachments} projectId={projectId} disabled={disabled || streaming} />
          {controls}

          <div className="ml-auto flex items-center gap-2">
            {tooLong && (
              <span className="text-xs text-destructive tabular-nums">
                {value.length.toLocaleString()} / {MAX_MESSAGE_LENGTH.toLocaleString()}
              </span>
            )}
            {streaming ? (
              <Button type="button" size="icon" onClick={onStop} aria-label="Stop generating" className="rounded-full">
                <SquareIcon className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled={!canSend} aria-label="Send" className="rounded-full">
                <ArrowUpIcon />
              </Button>
            )}
          </div>
        </div>
      </form>
      <p className="mt-2 hidden text-center text-xs text-muted-foreground sm:block">
        <kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift + Enter</kbd> for a new line · AI can make mistakes.
      </p>
    </div>
  );
}

