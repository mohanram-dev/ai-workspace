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

  const provider = data?.providers[0];
  return {
    loading: !data && !loadError,
    models: data?.models ?? [],
    listError: data?.error ?? loadError,
    configured: provider?.configured ?? false,
    providerName: provider?.name ?? "Model provider",
    selected,
    select,
  };
}
