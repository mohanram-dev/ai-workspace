"use client";

import type { ConversationDto } from "@aiw/shared";
import { MessagesSquareIcon, PinIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { fetchConversations } from "./api";
import { ConversationActions } from "./conversation-actions";
import { useConversations } from "./conversations-context";

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ConversationsPage() {
  const { conversations: sidebarList } = useConversations();
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConversationDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Server-side search covers titles and message content. Re-run when the
  // shared list changes so rename/pin/archive/delete are reflected.
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      fetchConversations({ q: query.trim() || undefined, archived: tab === "archived" })
        .then((rows) => {
          if (!active) return;
          setResults(rows);
          setError(null);
        })
        .catch((e: unknown) => active && setError(errorMessage(e)));
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, tab, sidebarList]);

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Conversations</h1>
        <p className="mt-1 text-sm text-muted-foreground">Search, rename, pin, archive and delete your conversations.</p>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles and messages"
              aria-label="Search conversations"
              className="h-9 pl-9"
            />
          </div>
          <div role="tablist" aria-label="Conversation filter" className="inline-flex rounded-lg border bg-muted/40 p-0.5">
            {(["active", "archived"] as const).map((value) => (
              <button
                key={value}
                role="tab"
                type="button"
                aria-selected={tab === value}
                onClick={() => {
                  setTab(value);
                  setResults(null);
                }}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground capitalize transition-colors",
                  tab === value && "bg-background text-foreground shadow-sm",
                )}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border bg-card">
          {error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : results === null ? (
            <div className="grid gap-3 p-4">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <MessagesSquareIcon className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {query ? "No conversations match your search." : tab === "archived" ? "No archived conversations." : "No conversations yet."}
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {results.map((conversation) => (
                <li key={conversation.id} className="group/item flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
                  <Link href={`/c/${conversation.id}`} className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      {conversation.pinned && <PinIcon className="size-3.5 shrink-0 text-muted-foreground" />}
                      <span className="truncate text-sm font-medium">{conversation.title}</span>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {dateFormatter.format(new Date(conversation.lastMessageAt))}
                    </span>
                  </Link>
                  <ConversationActions conversation={conversation} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
