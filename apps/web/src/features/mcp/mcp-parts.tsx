"use client";

import type { McpServerDto, ToolPermissionLevel } from "@aiw/shared";
import { KeyRoundIcon, PlusIcon, Undo2Icon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </header>
      <div className="grid grid-cols-1 gap-4 px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function McpStatusBadge({ server }: { server: Pick<McpServerDto, "status" | "enabled" | "available"> }) {
  if (!server.enabled) return <Badge variant="outline" className="text-[0.65rem]">Disabled</Badge>;
  if (!server.available) {
    return (
      <Badge variant="outline" className="border-warning/40 bg-warning/10 text-[0.65rem] text-foreground">
        Unavailable
      </Badge>
    );
  }
  const label = server.status === "connected" ? "Connected" : server.status === "error" ? "Error" : "Not tested";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 text-[0.65rem]",
        server.status === "connected" && "border-success/40 bg-success/10 text-foreground",
        server.status === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full bg-muted-foreground/50",
          server.status === "connected" && "bg-success",
          server.status === "error" && "bg-destructive",
        )}
      />
      {label}
    </Badge>
  );
}

/**
 * WRITE, EXECUTE and NETWORK are separate grants, not a ladder. An override
 * loosens protection when it makes a tool run without any grant (READ) or
 * lifts the DESTRUCTIVE block.
 */
export function isLowerPermission(level: ToolPermissionLevel, than: ToolPermissionLevel): boolean {
  return level !== than && (level === "READ" || than === "DESTRUCTIVE");
}

export function PermissionBadge({ level }: { level: ToolPermissionLevel }) {
  return (
    <Badge variant="outline" className={cn("font-mono text-[0.6rem]", level === "DESTRUCTIVE" && "border-destructive/40 text-destructive")}>
      {level}
    </Badge>
  );
}

/** One secret entry. `stored` rows already exist on the server; their values are never shown. */
export interface SecretRow {
  key: string;
  name: string;
  value: string;
  stored: boolean;
  removed: boolean;
}

let rowCounter = 0;
export function secretRows(names: string[]): SecretRow[] {
  return names.map((name) => ({ key: `row-${rowCounter++}`, name, value: "", stored: true, removed: false }));
}

/** Values for creating a server: every named row with its value. */
export function secretsForCreate(rows: SecretRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value]));
}

/** Write-only update: new or replaced values, and null for removed stored entries. Null when nothing changed. */
export function secretsForUpdate(rows: SecretRow[]): Record<string, string | null> | null {
  const changes: Record<string, string | null> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    if (row.stored && row.removed) changes[name] = null;
    else if (!row.stored || row.value !== "") changes[name] = row.value;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

export function SecretMapEditor({
  id,
  label,
  hint,
  namePlaceholder,
  rows,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  namePlaceholder: string;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
}) {
  const update = (key: string, patch: Partial<SecretRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5">
          <KeyRoundIcon className="size-3.5 text-muted-foreground" /> {label}
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([...rows, { key: `row-${rowCounter++}`, name: "", value: "", stored: false, removed: false }])}
        >
          <PlusIcon /> Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">None.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2">
          {rows.map((row, index) => (
            <li key={row.key} className={cn("grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]", row.removed && "opacity-60")}>
              <Input
                id={index === 0 ? id : undefined}
                aria-label={`${label} name`}
                value={row.name}
                placeholder={namePlaceholder}
                disabled={row.stored}
                className="font-mono text-xs"
                onChange={(e) => update(row.key, { name: e.target.value })}
              />
              <Input
                aria-label={`${label} value for ${row.name || "new entry"}`}
                type="password"
                autoComplete="off"
                value={row.value}
                disabled={row.removed}
                placeholder={row.stored ? (row.removed ? "Will be removed" : "Stored · type to replace") : "Value"}
                className="font-mono text-xs"
                onChange={(e) => update(row.key, { value: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={row.stored ? (row.removed ? `Keep ${row.name}` : `Remove ${row.name}`) : "Remove entry"}
                onClick={() => (row.stored ? update(row.key, { removed: !row.removed, value: "" }) : onChange(rows.filter((r) => r.key !== row.key)))}
              >
                {row.removed ? <Undo2Icon /> : <XIcon />}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
