"use client";

import { isAttachableImage, MAX_ATTACHMENTS_PER_MESSAGE, type MessageAttachment } from "@aiw/shared";
import { FileTextIcon, ImageIcon, Loader2Icon, PaperclipIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api-client";

/** Where chat attachments land inside the user's workspace (local disk). */
export const CHAT_UPLOAD_DIRECTORY = "chat-uploads";

interface AttachmentPickerProps {
  attachments: MessageAttachment[];
  onChange: (next: MessageAttachment[]) => void;
  projectId?: string | null | undefined;
  disabled: boolean;
}

/**
 * Attach files or images to a message (spec §3). Each file is uploaded into the
 * workspace as soon as it is chosen, so what is sent with the message is only a
 * reference the server can re-read; the bytes never travel with the chat request.
 */
export function AttachmentPicker({ attachments, onChange, projectId, disabled }: AttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const full = attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE;

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length;
    const chosen = [...files].slice(0, room);
    if (chosen.length < files.length) toast.error(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`);

    setUploading((n) => n + chosen.length);
    const added: MessageAttachment[] = [];
    for (const file of chosen) {
      try {
        const form = new FormData();
        form.set("file", file);
        form.set("directory", CHAT_UPLOAD_DIRECTORY);
        if (projectId) form.set("projectId", projectId);
        const response = await fetch("/api/files/upload", { method: "POST", body: form });
        const body = (await response.json().catch(() => null)) as { path?: string; size?: number; message?: string } | null;
        if (!response.ok || !body?.path) throw new Error(body?.message ?? `Upload failed (${response.status}).`);
        added.push({
          path: body.path,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: body.size ?? file.size,
          ...(projectId ? { projectId } : {}),
        });
      } catch (error) {
        toast.error(`${file.name}: ${errorMessage(error)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (added.length > 0) onChange([...attachments, ...added]);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        // Images are shown to the model; anything else is read as text.
        accept="image/png,image/jpeg,image/webp,text/*,.md,.json,.csv,.ts,.tsx,.js,.py,.yaml,.yml,.toml,.log,.txt"
        onChange={(e) => void upload(e.target.files)}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || full || uploading > 0}
            aria-label="Attach files or images"
            onClick={() => inputRef.current?.click()}
          >
            {uploading > 0 ? <Loader2Icon className="animate-spin" /> : <PaperclipIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{full ? `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments` : "Attach files or images"}</TooltipContent>
      </Tooltip>
    </>
  );
}

/** The chips above the composer, and on a sent message. */
export function AttachmentChips({ attachments, onRemove }: { attachments: MessageAttachment[]; onRemove?: (index: number) => void }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {attachments.map((attachment, index) => (
        <li key={`${attachment.path}-${index}`} className="flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
          {isAttachableImage(attachment.mimeType) ? <ImageIcon className="size-3.5 shrink-0" /> : <FileTextIcon className="size-3.5 shrink-0" />}
          <span className="truncate" title={attachment.path}>
            {attachment.name}
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">{formatSize(attachment.size)}</span>
          {onRemove && (
            <button type="button" onClick={() => onRemove(index)} aria-label={`Remove ${attachment.name}`} className="ml-0.5 rounded hover:bg-muted">
              <XIcon className="size-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
