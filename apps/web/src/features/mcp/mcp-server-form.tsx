"use client";

import { MCP_LIMITS, type McpCapabilitiesDto, type McpRefreshResultDto, type McpServerWithToolsDto, type McpTransport } from "@aiw/shared";
import { Loader2Icon, ShieldAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { Field, secretRows, SecretMapEditor, secretsForCreate, secretsForUpdate, Section, type SecretRow } from "./mcp-parts";

interface FormState {
  name: string;
  slug: string;
  description: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  timeoutSeconds: number;
  enabled: boolean;
  env: SecretRow[];
  headers: SecretRow[];
}

export function slugFromName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  if (!base) return "";
  return /^[a-z]/.test(base) ? base : `s_${base}`.slice(0, 32);
}

function initialState(server: McpServerWithToolsDto | null, canUseStdio: boolean): FormState {
  return {
    name: server?.name ?? "",
    slug: server?.slug ?? "",
    description: server?.description ?? "",
    transport: server?.transport ?? (canUseStdio ? "stdio" : "http"),
    command: server?.command ?? "",
    argsText: server?.args.join("\n") ?? "",
    url: server?.url ?? "",
    timeoutSeconds: server?.timeoutSeconds ?? 60,
    enabled: server?.enabled ?? true,
    env: secretRows(server?.envNames ?? []),
    headers: secretRows(server?.headerNames ?? []),
  };
}

const parseArgs = (text: string) => text.split(/\r?\n/).filter((line) => line.trim() !== "");

interface McpServerFormProps {
  server: McpServerWithToolsDto | null;
  capabilities: McpCapabilitiesDto;
  onSaved?: (server: McpServerWithToolsDto) => void;
  onCancel?: () => void;
}

/** Create a server (then test it), or edit an existing one. Secret values are write-only. */
export function McpServerForm({ server, capabilities, onSaved, onCancel }: McpServerFormProps) {
  const router = useRouter();
  const [state, setState] = useState<FormState>(() => initialState(server, capabilities.canUseStdio));
  const [slugEdited, setSlugEdited] = useState(Boolean(server));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setState((s) => ({ ...s, [key]: value }));
  const stdioLocked = state.transport === "stdio" && !capabilities.canUseStdio;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (!server) {
        const body = {
          name: state.name,
          slug: state.slug,
          description: state.description,
          transport: state.transport,
          enabled: state.enabled,
          timeoutSeconds: state.timeoutSeconds,
          ...(state.transport === "stdio"
            ? { command: state.command, args: parseArgs(state.argsText), env: secretsForCreate(state.env) }
            : { url: state.url, headers: secretsForCreate(state.headers) }),
        };
        const result = await apiFetch<McpRefreshResultDto>("/api/mcp", { method: "POST", body: JSON.stringify(body) });
        if (result.ok) toast.success(`Connected to ${result.server.name} · ${result.server.toolCount} tools discovered`);
        else toast.warning(`Saved, but the connection failed: ${result.error}`);
        router.push(`/mcp/${result.server.id}`);
        router.refresh();
        return;
      }

      const changes: Record<string, unknown> = {};
      if (state.name !== server.name) changes.name = state.name;
      if (state.description !== server.description) changes.description = state.description;
      if (state.enabled !== server.enabled) changes.enabled = state.enabled;
      if (state.timeoutSeconds !== server.timeoutSeconds) changes.timeoutSeconds = state.timeoutSeconds;
      if (server.transport === "stdio") {
        if (state.command !== server.command) changes.command = state.command;
        const args = parseArgs(state.argsText);
        if (JSON.stringify(args) !== JSON.stringify(server.args)) changes.args = args;
        const env = secretsForUpdate(state.env);
        if (env) changes.env = env;
      } else {
        if (state.url !== server.url) changes.url = state.url;
        const headers = secretsForUpdate(state.headers);
        if (headers) changes.headers = headers;
      }
      if (Object.keys(changes).length === 0) {
        onCancel?.();
        return;
      }
      const updated = await apiFetch<McpServerWithToolsDto>(`/api/mcp/${server.id}`, { method: "PATCH", body: JSON.stringify(changes) });
      toast.success("Server saved");
      onSaved?.(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-6">
      <Section title="Server" description="The name prefix is part of every tool name, e.g. github.search_repositories. It cannot be changed later.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="mcp-name">
            <Input
              id="mcp-name"
              value={state.name}
              required
              maxLength={60}
              onChange={(e) => {
                const name = e.target.value;
                setState((s) => ({ ...s, name, ...(slugEdited ? {} : { slug: slugFromName(name) }) }));
              }}
            />
          </Field>
          <Field label="Tool name prefix" htmlFor="mcp-slug" hint="2–32 lowercase letters, digits or underscores.">
            <Input
              id="mcp-slug"
              value={state.slug}
              required
              disabled={Boolean(server)}
              pattern="[a-z][a-z0-9_]{1,31}"
              className="font-mono text-xs"
              onChange={(e) => {
                setSlugEdited(true);
                set("slug", e.target.value.toLowerCase());
              }}
            />
          </Field>
        </div>
        <Field label="Description" htmlFor="mcp-description">
          <Textarea id="mcp-description" rows={2} maxLength={500} value={state.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span>
            <label htmlFor="mcp-enabled" className="block text-sm">
              Enabled
            </label>
            <span className="block text-xs text-muted-foreground">Disabled servers are never contacted and their tools are unavailable.</span>
          </span>
          <Switch id="mcp-enabled" checked={state.enabled} onCheckedChange={(on) => set("enabled", on)} />
        </div>
      </Section>

      <Section title="Connection">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Transport" htmlFor="mcp-transport">
            <Select value={state.transport} disabled={Boolean(server)} onValueChange={(v) => set("transport", v as McpTransport)}>
              <SelectTrigger id="mcp-transport" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">Streamable HTTP (remote URL)</SelectItem>
                <SelectItem value="stdio" disabled={!server && !capabilities.canUseStdio}>
                  stdio (local command){!capabilities.canUseStdio && " · not allowed"}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Timeout per tool call (seconds)" htmlFor="mcp-timeout">
            <Input
              id="mcp-timeout"
              type="number"
              min={MCP_LIMITS.timeoutSeconds.min}
              max={MCP_LIMITS.timeoutSeconds.max}
              required
              value={Number.isFinite(state.timeoutSeconds) ? state.timeoutSeconds : ""}
              onChange={(e) => set("timeoutSeconds", e.target.valueAsNumber)}
            />
          </Field>
        </div>

        {state.transport === "stdio" ? (
          <>
            <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
              <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>
                A stdio server is a program started on this host with the server&apos;s OS user. It is not sandboxed. Only add commands you trust.
                {!capabilities.stdioEnabled
                  ? " stdio servers are disabled on this server (MCP_STDIO_ENABLED=false)."
                  : !capabilities.canUseStdio
                    ? " Only administrators can change stdio servers."
                    : ""}
              </p>
            </div>
            <Field label="Command" htmlFor="mcp-command" hint={<>For example <span className="font-mono">npx</span> or an absolute path. No shell is used.</>}>
              <Input
                id="mcp-command"
                required
                maxLength={512}
                disabled={stdioLocked}
                className="font-mono text-xs"
                value={state.command}
                onChange={(e) => set("command", e.target.value)}
              />
            </Field>
            <Field label="Arguments" htmlFor="mcp-args" hint="One argument per line. Put secrets in environment variables, not arguments: arguments are shown in the UI.">
              <Textarea
                id="mcp-args"
                rows={3}
                disabled={stdioLocked}
                className="font-mono text-xs"
                placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder"}
                value={state.argsText}
                onChange={(e) => set("argsText", e.target.value)}
              />
            </Field>
            {!stdioLocked && (
              <SecretMapEditor
                id="mcp-env"
                label="Environment variables"
                namePlaceholder="GITHUB_TOKEN"
                hint="Encrypted at rest and never shown again. The server process gets only these plus safe defaults such as PATH, never this app's own secrets."
                rows={state.env}
                onChange={(rows) => set("env", rows)}
              />
            )}
          </>
        ) : (
          <>
            <Field
              label="URL"
              htmlFor="mcp-url"
              hint={
                capabilities.allowPrivateNetwork
                  ? "http(s) endpoint of a Streamable HTTP MCP server."
                  : "http(s) endpoint of a Streamable HTTP MCP server. Local and private network addresses are blocked (MCP_ALLOW_PRIVATE_NETWORK=false)."
              }
            >
              <Input
                id="mcp-url"
                type="url"
                required
                maxLength={2048}
                className="font-mono text-xs"
                placeholder="https://example.com/mcp"
                value={state.url}
                onChange={(e) => set("url", e.target.value)}
              />
            </Field>
            <SecretMapEditor
              id="mcp-headers"
              label="Headers"
              namePlaceholder="Authorization"
              hint="For API keys, e.g. Authorization: Bearer <token>. Encrypted at rest and never shown again. OAuth sign-in for MCP servers is NOT IMPLEMENTED yet."
              rows={state.headers}
              onChange={(rows) => set("headers", rows)}
            />
          </>
        )}
      </Section>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={saving || (!server && stdioLocked)}>
          {saving && <Loader2Icon className="animate-spin" />}
          {server ? "Save changes" : "Add server and discover tools"}
        </Button>
        <Button type="button" variant="outline" onClick={() => (onCancel ? onCancel() : router.push("/mcp"))}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
