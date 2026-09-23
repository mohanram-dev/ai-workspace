"use client";

import type { ApiTokenDto, CreatedApiTokenDto } from "@aiw/shared";
import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { SecretReveal } from "@/components/secret-reveal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/format";

/** Personal API tokens: start and read tasks from scripts, n8n or another server. */
export function ApiTokens() {
  const [tokens, setTokens] = useState<ApiTokenDto[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiTokenDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<{ tokens: ApiTokenDto[] }>("/api/tokens")
      .then((r) => active && setTokens(r.tokens))
      .catch((e: unknown) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const token = await apiFetch<CreatedApiTokenDto>("/api/tokens", { method: "POST", body: JSON.stringify({ name }) });
      setCreated(token);
      setTokens((current) => [token, ...(current ?? [])]);
      setName("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  async function remove(token: ApiTokenDto) {
    const previous = tokens;
    setTokens((current) => current?.filter((t) => t.id !== token.id) ?? null);
    if (created?.id === token.id) setCreated(null);
    try {
      await apiFetch(`/api/tokens/${token.id}`, { method: "DELETE" });
      toast.success(`Revoked “${token.name}”`);
    } catch (e) {
      setTokens(previous);
      toast.error(errorMessage(e));
    }
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className="grid gap-3 px-4 py-3 sm:px-5">
      <p className="text-xs text-muted-foreground">
        A token can start tasks and read their results through <code className="font-mono">/api/tasks</code> — nothing else. Send it as{" "}
        <code className="font-mono">Authorization: Bearer …</code>. Revoke a token the moment it may have leaked.
      </p>
      {created && (
        <SecretReveal label={`Token “${created.name}”`} value={created.token}>
          <pre className="scrollbar-thin overflow-x-auto rounded-md border bg-card p-2 text-[0.7rem] leading-5">
            {`curl -X POST ${origin}/api/tasks \\\n  -H "Authorization: Bearer ${created.token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt": "Summarise the latest Node.js release notes"}'`}
          </pre>
        </SecretReveal>
      )}
      <form method="post" onSubmit={(e) => void create(e)} className="flex flex-wrap gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. n8n" maxLength={80} required aria-label="Token name" className="min-w-0 flex-1" />
        <Button type="submit" disabled={creating || !name.trim()}>
          {creating ? <Loader2Icon className="animate-spin" /> : <PlusIcon />} Create token
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {tokens === null ? null : tokens.length === 0 ? (
        <p className="text-xs text-muted-foreground">No tokens yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {tokens.map((token) => (
            <li key={token.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{token.name}</span>
              <code className="font-mono text-xs text-muted-foreground">{token.prefix}…</code>
              <span className="text-xs text-muted-foreground">{token.lastUsedAt ? `used ${formatRelativeTime(token.lastUsedAt)}` : "never used"}</span>
              <Button size="icon-sm" variant="ghost" aria-label={`Revoke ${token.name}`} onClick={() => void remove(token)}>
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
