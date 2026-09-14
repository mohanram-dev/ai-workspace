"use client";

import type { ConversationDto } from "@aiw/shared";
import { PinIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDeferredValue, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ConversationActions } from "./conversation-actions";
import { useConversations } from "./conversations-context";

export function SidebarConversationList({ onNavigate }: { onNavigate?: () => void }) {
  const { conversations, loading, error } = useConversations();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const filtered = deferredQuery
    ? conversations.filter((c) => c.title.toLowerCase().includes(deferredQuery))
    : conversations;
  const pinned = filtered.filter((c) => c.pinned);
  const recent = filtered.filter((c) => !c.pinned);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative px-3 pb-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-5.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
          className="h-8 w-full rounded-md border border-transparent bg-sidebar-accent/60 pr-2 pl-7.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring/50 focus:bg-background"
        />
      </div>

      <nav aria-label="Conversations" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="grid gap-1.5 px-2 pt-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-6" style={{ width: `${90 - i * 8}%` }} />
            ))}
          </div>
        ) : error ? (
          <p className="px-2 pt-2 text-xs text-destructive">{error}</p>
        ) : filtered.length === 0 ? (
          <p className="px-2 pt-2 text-xs text-muted-foreground">
            {deferredQuery ? "No matching conversations." : "No conversations yet."}
          </p>
        ) : (
          <>
            {pinned.length > 0 && <Section label="Pinned" items={pinned} onNavigate={onNavigate} />}
            {recent.length > 0 && <Section label="Recent" items={recent} onNavigate={onNavigate} />}
          </>
        )}
      </nav>
    </div>
  );
}

function Section({
  label,
  items,
  onNavigate,
}: {
  label: string;
  items: ConversationDto[];
  onNavigate: (() => void) | undefined;
}) {
  const pathname = usePathname();
  return (
    <div className="mb-2">
      <h3 className="px-2 pt-2 pb-1 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </h3>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-px">
        {items.map((conversation) => {
          const active = pathname === `/c/${conversation.id}`;
          return (
            <li key={conversation.id} className="group/item relative min-w-0">
              <Link
                href={`/c/${conversation.id}`}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md pr-8 pl-2 text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                )}
              >
                {conversation.pinned && <PinIcon className="size-3 shrink-0 text-muted-foreground" />}
                <span className="truncate">{conversation.title}</span>
              </Link>
              <ConversationActions
                conversation={conversation}
                className="absolute top-1/2 right-1 -translate-y-1/2 opacity-100 group-focus-within/item:opacity-100 group-hover/item:opacity-100 md:opacity-0 aria-expanded:opacity-100"
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
