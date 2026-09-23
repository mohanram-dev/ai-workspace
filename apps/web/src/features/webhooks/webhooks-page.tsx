"use client";

import type { AgentDto, ProjectDto, WebhookDto, WebhookWithSecretDto } from "@aiw/shared";
import { CheckIcon, CopyIcon, KeyRoundIcon, MessagesSquareIcon, PlusIcon, Trash2Icon, WebhookIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SecretReveal } from "@/components/secret-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fetchAgents } from "../agents/use-agents";
import { useCopy } from "../chat/use-copy";
import { useModels } from "../chat/use-models";
import { WebhookForm } from "./webhook-form";

/** Inbound webhooks: a URL per job that other services post to, each starting a task. */
export function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<WebhookDto[] | null>(null);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<WebhookWithSecretDto | null>(null);
  const { models } = useModels();

  useEffect(() => {
    let active = true;
    Promise.all([apiFetch<{ webhooks: WebhookDto[] }>("/api/webhooks"), fetchAgents(), apiFetch<{ projects: ProjectDto[] }>("/api/projects")])
      .then(([w, a, p]) => {
        if (!active) return;
        setWebhooks(w.webhooks);
        setAgents(a.filter((agent) => agent.enabled));
        setProjects(p.projects);
      })
      .catch((e: unknown) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, []);

  function replace(webhook: WebhookDto) {
    setWebhooks((current) => {
      const rest = (current ?? []).filter((w) => w.id !== webhook.id);
      return [...rest, webhook].sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  function saved(webhook: WebhookDto | WebhookWithSecretDto) {
    replace(webhook);
    if ("secret" in webhook) setRevealed(webhook);
    setCreating(false);
    setEditing(null);
  }

  async function toggle(webhook: WebhookDto, enabled: boolean) {
    replace({ ...webhook, enabled });
    try {
      replace(await apiFetch<WebhookDto>(`/api/webhooks/${webhook.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }));
    } catch (e) {
      replace(webhook);
      toast.error(errorMessage(e));
    }
  }

  async function rotate(webhook: WebhookDto) {
    try {
      setRevealed(await apiFetch<WebhookWithSecretDto>(`/api/webhooks/${webhook.id}/secret`, { method: "POST" }));
      toast.success("New secret made. The old one no longer works.");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove(webhook: WebhookDto) {
    const previous = webhooks;
    setWebhooks((current) => current?.filter((w) => w.id !== webhook.id) ?? null);
    if (revealed?.id === webhook.id) setRevealed(null);
    try {
      await apiFetch(`/api/webhooks/${webhook.id}`, { method: "DELETE" });
    } catch (e) {
      setWebhooks(previous);
      toast.error(errorMessage(e));
    }
  }

  const formProps = { agents, projects, models, onSaved: saved };

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Let another service start a task: GitHub on a new issue, n8n in a workflow, a script on another server. Each webhook has its own URL and secret, and
              its runs go to one conversation.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setCreating((v) => !v);
              setEditing(null);
            }}
          >
            <PlusIcon /> New webhook
          </Button>
        </div>

        {creating && (
          <div className="mt-4">
            <WebhookForm {...formProps} onCancel={() => setCreating(false)} />
          </div>
        )}

        {revealed && (
          <div className="mt-4">
            <SecretReveal label={`Secret for “${revealed.name}”`} value={revealed.secret}>
              <Instructions path={revealed.path} secret={revealed.secret} />
            </SecretReveal>
          </div>
        )}

        {error ? (
          <p role="alert" className="mt-6 text-sm text-destructive">
            {error}
          </p>
        ) : webhooks === null ? (
          <div className="mt-6 grid gap-3">
            <Skeleton className="h-28 rounded-xl" />
          </div>
        ) : webhooks.length === 0 && !creating ? (
          <div className="mt-6 rounded-xl border border-dashed px-6 py-10 text-center">
            <WebhookIcon className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 font-medium">No webhooks yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">For example: when GitHub reports a new issue, have the Research Agent triage it.</p>
          </div>
        ) : (
          <ul className="mt-6 grid gap-3">
            {webhooks.map((webhook) =>
              editing === webhook.id ? (
                <li key={webhook.id}>
                  <WebhookForm {...formProps} webhook={webhook} onCancel={() => setEditing(null)} />
                </li>
              ) : (
                <li key={webhook.id} className={cn("rounded-xl border bg-card", !webhook.enabled && "opacity-70")}>
                  <div className="flex flex-wrap items-start gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="min-w-0 truncate font-medium">{webhook.name}</h2>
                        {webhook.agent && <Badge variant="secondary">{webhook.agent.name}</Badge>}
                        {webhook.project && <Badge variant="outline">{webhook.project.name}</Badge>}
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{webhook.prompt}</p>
                      <UrlRow path={webhook.path} />
                      <p className="mt-2 text-xs text-muted-foreground">
                        {webhook.triggerCount} deliver{webhook.triggerCount === 1 ? "y" : "ies"}
                        {webhook.lastTriggeredAt ? ` · last ${formatRelativeTime(webhook.lastTriggeredAt)}` : ""}
                      </p>
                    </div>
                    <Switch
                      checked={webhook.enabled}
                      onCheckedChange={(on) => void toggle(webhook, on)}
                      aria-label={`${webhook.enabled ? "Disable" : "Enable"} ${webhook.name}`}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2 border-t px-4 py-2">
                    {webhook.conversationId && (
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/c/${webhook.conversationId}`}>
                          <MessagesSquareIcon /> Conversation
                        </Link>
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setEditing(webhook.id)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void rotate(webhook)}>
                      <KeyRoundIcon /> New secret
                    </Button>
                    <Button size="sm" variant="ghost" className="ml-auto" aria-label={`Delete ${webhook.name}`} onClick={() => void remove(webhook)}>
                      <Trash2Icon />
                    </Button>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function useOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

function UrlRow({ path }: { path: string }) {
  const { copied, copy } = useCopy();
  const url = `${useOrigin()}${path}`;
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{url}</code>
      <Button size="icon-xs" variant="ghost" aria-label="Copy URL" onClick={() => void copy(url)}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/** How to call the webhook from the places people usually do. */
function Instructions({ path, secret }: { path: string; secret: string }) {
  const origin = useOrigin();
  const url = `${origin}${path}`;
  const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(origin);
  return (
    <div className="grid gap-2 text-xs">
      <p className="font-medium">Send a test delivery</p>
      <pre className="scrollbar-thin overflow-x-auto rounded-md border bg-card p-2 leading-5">
        {`curl -X POST ${url} \\\n  -H "X-Webhook-Secret: ${secret}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title": "Test from curl"}'`}
      </pre>
      <p>
        <span className="font-medium">GitHub:</span> Settings → Webhooks → Add webhook. Payload URL = the URL above, content type{" "}
        <span className="font-mono">application/json</span>, Secret = this secret. Signatures (<span className="font-mono">X-Hub-Signature-256</span>) are checked.
      </p>
      <p>
        <span className="font-medium">n8n / scripts:</span> POST to the URL with the header <span className="font-mono">X-Webhook-Secret</span>. The answer is{" "}
        <span className="font-mono">{"{taskId, conversationId}"}</span>; poll <span className="font-mono">/api/tasks/&lt;taskId&gt;</span> with an API token for the result.
      </p>
      {local && (
        <p className="text-warning">
          This app is on a local address, so only this computer can reach the URL. A service on the internet (GitHub) needs the app on a public address, such as
          one behind a tunnel or a reverse proxy.
        </p>
      )}
    </div>
  );
}
