"use client";

import { CheckIcon, CopyIcon, KeyRoundIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCopy } from "@/features/chat/use-copy";

/** A secret shown once, right after it was made: copy it now, it cannot be shown again. */
export function SecretReveal({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  const { copied, copy } = useCopy();
  return (
    <div role="status" className="grid gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <KeyRoundIcon className="size-4 text-warning" /> {label}
      </p>
      <div className="flex gap-2">
        <Input readOnly value={value} aria-label={label} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" onClick={() => void copy(value)}>
          {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Copy it now and keep it somewhere safe. It is stored encrypted or hashed, and will not be shown again.</p>
      {children}
    </div>
  );
}
