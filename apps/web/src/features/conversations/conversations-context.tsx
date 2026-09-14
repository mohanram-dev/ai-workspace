"use client";

import type { ConversationDto, UpdateConversationInput } from "@aiw/shared";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api-client";
import { deleteConversation, fetchConversations, updateConversation } from "./api";

interface ConversationsContextValue {
  conversations: ConversationDto[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Inserts or updates a conversation and moves it to the top of the list. */
  upsert: (conversation: Pick<ConversationDto, "id" | "title"> & Partial<ConversationDto>) => void;
  update: (id: string, changes: UpdateConversationInput) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}

const ConversationsContext = createContext<ConversationsContextValue | null>(null);

function sortConversations(list: ConversationDto[]): ConversationDto[] {
  return [...list].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.lastMessageAt.localeCompare(a.lastMessageAt),
  );
}

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setConversations(await fetchConversations());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial load of the sidebar list; state updates happen after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const upsert = useCallback<ConversationsContextValue["upsert"]>((incoming) => {
    setConversations((current) => {
      const now = new Date().toISOString();
      const existing = current.find((c) => c.id === incoming.id);
      const merged: ConversationDto = {
        pinned: false,
        archived: false,
        projectId: null,
        createdAt: now,
        ...existing,
        ...incoming,
        lastMessageAt: incoming.lastMessageAt ?? now,
      };
      return sortConversations([merged, ...current.filter((c) => c.id !== incoming.id)]);
    });
  }, []);

  const update = useCallback<ConversationsContextValue["update"]>(
    async (id, changes) => {
      try {
        const updated = await updateConversation(id, changes);
        setConversations((current) =>
          sortConversations(
            updated.archived
              ? current.filter((c) => c.id !== id)
              : current.some((c) => c.id === id)
                ? current.map((c) => (c.id === id ? updated : c))
                : [updated, ...current],
          ),
        );
        if (changes.archived !== undefined) {
          toast.success(changes.archived ? "Conversation archived" : "Conversation restored");
        }
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      }
    },
    [],
  );

  const remove = useCallback<ConversationsContextValue["remove"]>(
    async (id) => {
      try {
        await deleteConversation(id);
        setConversations((current) => current.filter((c) => c.id !== id));
        if (pathname === `/c/${id}` || window.location.pathname === `/c/${id}`) router.push("/");
        toast.success("Conversation deleted");
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      }
    },
    [pathname, router],
  );

  const value = useMemo(
    () => ({ conversations, loading, error, refresh, upsert, update, remove }),
    [conversations, loading, error, refresh, upsert, update, remove],
  );

  return <ConversationsContext.Provider value={value}>{children}</ConversationsContext.Provider>;
}

export function useConversations(): ConversationsContextValue {
  const value = useContext(ConversationsContext);
  if (!value) throw new Error("useConversations must be used within ConversationsProvider");
  return value;
}
