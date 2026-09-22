"use client";

import type { ModelsResponse } from "@aiw/shared";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";

const STORAGE_KEY = "aiw:selected-model";
let cached: Promise<ModelsResponse> | null = null;

function loadModels(): Promise<ModelsResponse> {
  cached ??= apiFetch<ModelsResponse>("/api/models").catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}

export function useModels() {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    loadModels()
      .then((response) => {
        if (!active) return;
        setData(response);
        const stored = window.localStorage.getItem(STORAGE_KEY);
        const valid = stored && response.models.some((m) => m.id === stored) ? stored : response.defaultModel;
        setSelected(valid ?? undefined);
      })
      .catch((error: unknown) => active && setLoadError(errorMessage(error)));
    return () => {
      active = false;
    };
  }, []);

  const select = useCallback((model: string) => {
    setSelected(model);
    window.localStorage.setItem(STORAGE_KEY, model);
  }, []);

  // Models come from every configured provider, so "configured" means at least
  // one of them is — reading providers[0] alone said "not configured" whenever
  // the first registered provider happened to be the unused one.
  const providers = data?.providers ?? [];
  const usable = providers.filter((p) => p.configured);
  const providerNames = Object.fromEntries(providers.map((p) => [p.id, p.name]));

  return {
    loading: !data && !loadError,
    models: data?.models ?? [],
    listError: data?.error ?? loadError,
    configured: usable.length > 0,
    providerName: usable.length === 1 ? usable[0]!.name : "Model provider",
    providerNames,
    selected,
    select,
  };
}
