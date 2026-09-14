"use client";

import {
  MCP_PERMISSION_LEVELS,
  type McpCapabilitiesDto,
  type McpRefreshResultDto,
  type McpServerWithToolsDto,
  type McpToolDto,
  type ToolPermissionLevel,
} from "@aiw/shared";
import { AlertTriangleIcon, ArrowLeftIcon, Loader2Icon, PencilIcon, PlugIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { isLowerPermission, McpStatusBadge, PermissionBadge, Section } from "./mcp-parts";
import { McpServerForm } from "./mcp-server-form";

const DEFAULT_PERMISSION = "__default__";
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function McpServerDetail({ initial, capabilities }: { initial: McpServerWithToolsDto; capabilities: McpCapabilitiesDto }) {
  const router = useRouter();
  const [server, setServer] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      const result = await apiFetch<McpRefreshResultDto>(`/api/mcp/${server.id}/refresh`, { method: "POST" });
      setServer(result.server);
      if (result.ok) {
        const changes = [result.added && `${result.added} new`, result.removed && `${result.removed} removed`, result.skipped && `${result.skipped} skipped`]
          .filter(Boolean)
          .join(", ");
        toast.success(`Connected · ${result.server.toolCount} tools${changes ? ` (${changes})` : ""}`);
      } else {
        toast.error(result.error ?? "Connection failed");
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function toggleServer(enabled: boolean) {
    const previous = server;
    setServer({ ...server, enabled });
    try {
      setServer(await apiFetch<McpServerWithToolsDto>(`/api/mcp/${server.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }));
    } catch (e) {
      setServer(previous);
      toast.error(errorMessage(e));
    }
  }

  async function updateTool(tool: McpToolDto, changes: { enabled?: boolean; permission?: ToolPermissionLevel | null }) {
    const optimistic = { ...tool, ...changes, effectivePermission: changes.permission === undefined ? tool.effectivePermission : (changes.permission ?? tool.defaultPermission) };
    setServer((s) => ({ ...s, tools: s.tools.map((t) => (t.id === tool.id ? optimistic : t)) }));
    try {
      const updated = await apiFetch<McpToolDto>(`/api/mcp/${server.id}/tools/${tool.id}`, { method: "PATCH", body: JSON.stringify(changes) });
      setServer((s) => ({
        ...s,
        tools: s.tools.map((t) => (t.id === tool.id ? updated : t)),
        enabledToolCount: s.tools.filter((t) => (t.id === tool.id ? updated.enabled : t.enabled)).length,
      }));
    } catch (e) {
      setServer((s) => ({ ...s, tools: s.tools.map((t) => (t.id === tool.id ? tool : t)) }));
      toast.error(errorMessage(e));
    }
  }

  async function remove() {
    try {
      await apiFetch(`/api/mcp/${server.id}`, { method: "DELETE" });
      toast.success(`${server.name} removed`);
      router.push("/mcp");
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <div>
          <Link href="/mcp" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-4" /> MCP Tools
          </Link>
          <div className="mt-3 flex flex-wrap items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/50">
              <PlugIcon className="size-5 text-muted-foreground" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-semibold tracking-tight break-words">{server.name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <McpStatusBadge server={server} />
                <Badge variant="secondary" className="font-mono text-[0.65rem]">
                  {server.slug}.*
                </Badge>
                <Badge variant="outline" className="text-[0.65rem]">
                  {server.transport === "stdio" ? "stdio" : "Streamable HTTP"}
                </Badge>
              </div>
            </div>
            <Switch checked={server.enabled} onCheckedChange={(on) => void toggleServer(on)} aria-label={server.enabled ? "Disable server" : "Enable server"} />
          </div>
          {server.description && <p className="mt-3 text-sm text-muted-foreground">{server.description}</p>}
        </div>

        {editing ? (
          <McpServerForm
            server={server}
            capabilities={capabilities}
            onCancel={() => setEditing(false)}
            onSaved={(updated) => {
              setServer(updated);
              setEditing(false);
            }}
          />
        ) : (
          <Section
            title="Connection"
            action={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void refresh()} disabled={refreshing}>
                  {refreshing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Test and refresh tools
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  <PencilIcon /> Edit
                </Button>
              </div>
            }
          >
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
              <dt className="text-muted-foreground">{server.transport === "stdio" ? "Command" : "URL"}</dt>
              <dd className="font-mono text-xs break-all">
                {server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}
              </dd>
              <dt className="text-muted-foreground">{server.transport === "stdio" ? "Environment" : "Headers"}</dt>
              <dd className="font-mono text-xs break-all">
                {(server.transport === "stdio" ? server.envNames : server.headerNames).join(", ") || <span className="font-sans text-muted-foreground">None</span>}
                {(server.transport === "stdio" ? server.envNames : server.headerNames).length > 0 && (
                  <span className="font-sans text-muted-foreground"> · values encrypted</span>
                )}
              </dd>
              <dt className="text-muted-foreground">Reported server</dt>
              <dd>{server.serverName ? `${server.serverName}${server.serverVersion ? ` ${server.serverVersion}` : ""}` : "—"}</dd>
              <dt className="text-muted-foreground">Last checked</dt>
              <dd>{server.lastCheckedAt ? dateFormatter.format(new Date(server.lastCheckedAt)) : "Never"}</dd>
              <dt className="text-muted-foreground">Timeout</dt>
              <dd>{server.timeoutSeconds} s per tool call</dd>
            </dl>
            {!server.available && server.unavailableReason && server.enabled && (
              <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" /> {server.unavailableReason}
              </p>
            )}
            {server.lastError && (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs break-words text-destructive">
                {server.lastError}
              </p>
            )}
          </Section>
        )}

        <Section
          title={`Tools · ${server.enabledToolCount} of ${server.toolCount} enabled`}
          description="Assign tools to agents in the agent editor. Permission levels come from the server's hints; they are not guarantees, so review them before lowering one."
        >
          {server.tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {server.status === "connected" ? "This server offers no tools." : "No tools discovered yet. Test the connection to discover them."}
            </p>
          ) : (
            <ul className="grid grid-cols-1 divide-y rounded-lg border">
              {server.tools.map((tool) => (
                <ToolRow key={tool.id} tool={tool} onChange={(changes) => void updateTool(tool, changes)} />
              ))}
            </ul>
          )}
        </Section>

        <div className="flex flex-wrap items-center gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="destructive">
                <Trash2Icon /> Remove server
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {server.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Its tools are unassigned from every agent and its stored secrets are deleted. Past tasks keep their tool call history.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void remove()}>
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}

function ToolRow({ tool, onChange }: { tool: McpToolDto; onChange: (changes: { enabled?: boolean; permission?: ToolPermissionLevel | null }) => void }) {
  const lowered = tool.permission !== null && isLowerPermission(tool.permission, tool.defaultPermission);
  const hints = tool.annotations;
  return (
    <li className={cn("grid grid-cols-1 gap-2 px-3 py-3", !tool.enabled && "opacity-70")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <label htmlFor={`mcp-tool-${tool.id}`} className="font-mono text-xs font-medium break-all">
              {tool.qualifiedName}
            </label>
            <PermissionBadge level={tool.effectivePermission} />
            {hints?.readOnlyHint && <Badge variant="outline" className="text-[0.6rem]">read-only hint</Badge>}
            {hints?.destructiveHint && (
              <Badge variant="outline" className="border-destructive/40 text-[0.6rem] text-destructive">
                destructive hint
              </Badge>
            )}
            {hints?.openWorldHint && <Badge variant="outline" className="text-[0.6rem]">open world</Badge>}
          </div>
          {tool.title && tool.title !== tool.name && <p className="mt-0.5 text-sm">{tool.title}</p>}
          {tool.description && <p className="mt-0.5 line-clamp-3 text-xs whitespace-pre-line text-muted-foreground">{tool.description}</p>}
        </div>
        <Switch id={`mcp-tool-${tool.id}`} checked={tool.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={tool.permission ?? DEFAULT_PERMISSION}
          onValueChange={(value) => onChange({ permission: value === DEFAULT_PERMISSION ? null : (value as ToolPermissionLevel) })}
        >
          <SelectTrigger size="sm" className="w-56" aria-label={`Permission for ${tool.qualifiedName}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_PERMISSION}>Default · {tool.defaultPermission}</SelectItem>
            {MCP_PERMISSION_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {lowered && (
          <span className="flex items-center gap-1 text-xs text-warning">
            <AlertTriangleIcon className="size-3.5" /> {tool.effectivePermission === "READ" ? "Runs without any permission grant" : "No longer blocked as destructive"}
          </span>
        )}
        <details className="w-full">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Input schema</summary>
          <pre className="scrollbar-thin mt-1 max-h-60 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[0.7rem] leading-5">
            {JSON.stringify(tool.inputSchema, null, 2)}
          </pre>
        </details>
      </div>
    </li>
  );
}
