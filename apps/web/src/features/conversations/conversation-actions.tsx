"use client";

import type { ConversationDto } from "@aiw/shared";
import { MAX_TITLE_LENGTH } from "@aiw/shared";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useConversations } from "./conversations-context";

interface ConversationActionsProps {
  conversation: ConversationDto;
  className?: string;
  align?: "start" | "end";
}

export function ConversationActions({ conversation, className, align = "end" }: ConversationActionsProps) {
  const { update, remove } = useConversations();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function onRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    if (!title || title === conversation.title) {
      setRenameOpen(false);
      return;
    }
    if (await update(conversation.id, { title })) setRenameOpen(false);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${conversation.title}`}
            className={cn("text-muted-foreground", className)}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-44">
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            <PencilIcon /> Rename
          </DropdownMenuItem>
          {!conversation.archived && (
            <DropdownMenuItem onSelect={() => void update(conversation.id, { pinned: !conversation.pinned })}>
              {conversation.pinned ? <PinOffIcon /> : <PinIcon />}
              {conversation.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void update(conversation.id, { archived: !conversation.archived })}>
            {conversation.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
            {conversation.archived ? "Restore" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2Icon /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={onRename}>
            <DialogHeader>
              <DialogTitle>Rename conversation</DialogTitle>
              <DialogDescription className="sr-only">Enter a new title for this conversation.</DialogDescription>
            </DialogHeader>
            <Input
              name="title"
              defaultValue={conversation.title}
              maxLength={MAX_TITLE_LENGTH}
              autoFocus
              className="my-4"
              aria-label="Title"
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              “{conversation.title}” and all of its messages will be permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove(conversation.id)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
