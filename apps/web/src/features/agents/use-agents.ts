"use client";

import type { AgentDto } from "@aiw/shared";
import { useEffect, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";

export function fetchAgents(): Promise<AgentDto[]> {
  return apiFetch<{ agents: AgentDto[] }>("/api/agents").then((r) => r.agents);
}

/** Loads agents; `refreshMs` keeps live status fresh while the page is open. */
export function useAgents(options: { refreshMs?: number } = {}) {
  const [agents, setAgents] = useState<AgentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refreshMs } = options;

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchAgents()
        .then((rows) => active && setAgents(rows))
        .catch((e: unknown) => active && setError(errorMessage(e)));
    void load();
    const timer = refreshMs ? window.setInterval(() => void load(), refreshMs) : undefined;
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshMs]);

  return { agents: agents ?? [], loading: agents === null && !error, error, setAgents };
}
