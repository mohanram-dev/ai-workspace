"use client";

import type { McpCapabilitiesDto, McpServerDto } from "@aiw/shared";
import { PlugIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { McpStatusBadge } from "./mcp-parts";

export function McpPage({ capabilities }: { capabilities: McpCapabilitiesDto }) {
  const [servers, setServers] = useState<McpServerDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<{ servers: McpServerDto[] }>("/api/mcp")
      .then((r) => active && setServers(r.servers))
      .catch((e: unknown) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, []);

  async function toggle(server: McpServerDto, enabled: boolean) {
    setServers((current) => current?.map((s) => (s.id === server.id ? { ...s, enabled } : s)) ?? null);
    try {
      const updated = await apiFetch<McpServerDto>(`/api/mcp/${server.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      setServers((current) => current?.map((s) => (s.id === server.id ? updated : s)) ?? null);
    } catch (e) {
      setServers((current) => current?.map((s) => (s.id === server.id ? server : s)) ?? null);
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">MCP Tools</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Connect Model Context Protocol servers. Their tools are discovered automatically and can be assigned to agents one by one, with a
              permission level each.
            </p>
          </div>
          <Button asChild>
            <Link href="/mcp/new">
              <PlusIcon /> Add server
            </Link>
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 rounded-xl border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <span>Streamable HTTP: available</span>
          <span>
            stdio: {capabilities.stdioEnabled ? (capabilities.canUseStdio ? "available (administrator)" : "administrators only") : "disabled on this server"}
          </span>
          <span>Private network URLs: {capabilities.allowPrivateNetwork ? "allowed" : "blocked"}</span>
          <span>OAuth sign-in, prompts and resources: NOT IMPLEMENTED</span>
        </div>

        {error ? (
          <p className="mt-6 text-sm text-destructive">{error}</p>
        ) : servers === null ? (
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        ) : servers.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed px-6 py-10 text-center">
            <PlugIcon className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 font-medium">No MCP servers yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Add a remote server by URL (for example a hosted GitHub or documentation MCP server with an API key header)
              {capabilities.canUseStdio ? ", or a local command such as npx -y @modelcontextprotocol/server-filesystem <folder>" : ""}.
            </p>
            <Button asChild className="mt-4">
              <Link href="/mcp/new">
                <PlusIcon /> Add server
              </Link>
            </Button>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {servers.map((server) => (
              <div key={server.id} className={cn("relative flex flex-col rounded-xl border bg-card p-4 transition-colors hover:border-ring/40", !server.enabled && "opacity-70")}>
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                    <PlugIcon className="size-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link href={`/mcp/${server.id}`} className="font-medium break-words after:absolute after:inset-0 hover:underline">
                      {server.name}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      <McpStatusBadge server={server} />
                      <Badge variant="secondary" className="font-mono text-[0.65rem]">
                        {server.slug}.*
                      </Badge>
                      <Badge variant="outline" className="text-[0.65rem]">
                        {server.transport === "stdio" ? "stdio" : "HTTP"}
                      </Badge>
                    </div>
                  </div>
                  <Switch
                    checked={server.enabled}
                    onCheckedChange={(on) => void toggle(server, on)}
                    aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                    className="relative z-10"
                  />
                </div>
                <p className="mt-3 truncate font-mono text-xs text-muted-foreground">
                  {server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}
                </p>
                {server.lastError ? (
                  <p className="mt-2 line-clamp-2 text-xs text-destructive">{server.lastError}</p>
                ) : (
                  !server.available && server.unavailableReason && <p className="mt-2 line-clamp-2 text-xs text-warning">{server.unavailableReason}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {server.enabledToolCount} of {server.toolCount} tools enabled
                  </span>
                  {server.serverName && (
                    <span>
                      {server.serverName}
                      {server.serverVersion ? ` ${server.serverVersion}` : ""}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
