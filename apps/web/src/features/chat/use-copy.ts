"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export function useCopy(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      try {
        // The Clipboard API exists only in secure contexts; a LAN address over
        // plain http is a legitimate deployment (CLAUDE.md §10), so fall back.
        if (navigator.clipboard) await navigator.clipboard.writeText(text);
        else copyWithSelection(text);
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), resetMs);
      } catch {
        toast.error("Could not copy to clipboard");
      }
    },
    [resetMs],
  );

  return { copied, copy };
}

/** The pre-Clipboard-API way: select a hidden textarea and ask the browser to copy it. */
function copyWithSelection(text: string): void {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("Copy was refused");
}
