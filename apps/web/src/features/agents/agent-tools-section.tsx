"use client";

import { AGENT_LIMITS, GRANTABLE_PERMISSIONS, type GrantablePermission, type ToolInfoDto } from "@aiw/shared";
import { AlertTriangleIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const CATEGORY_LABELS: Record<ToolInfoDto["category"], string> = {
  files: "Files",
  git: "Git",
  terminal: "Terminal",
  web: "Web",
  browser: "Browser",
  computer: "Computer",
  memory: "Memory",
  agent: "Agents",
  docker: "Docker",
  ssh: "SSH",
  github: "GitHub",
  mcp: "MCP",
};

const PERMISSION_HELP: Record<GrantablePermission, string> = {
  WRITE: "Create and modify files, commit with git",
  EXECUTE: "Run terminal commands, use the browser, control the computer, act through MCP tools",
  NETWORK: "Search the web and fetch pages",
};

interface AgentToolsSectionProps {
  available: ToolInfoDto[];
  tools: string[];
  permissions: GrantablePermission[];
  maxToolCalls: number;
  onToolsChange: (tools: string[]) => void;
  onPermissionsChange: (permissions: GrantablePermission[]) => void;
  onMaxToolCallsChange: (value: number) => void;
}

/** Tool assignment and permission grants for an agent (spec §14–16). */
export function AgentToolsSection({
  available,
  tools,
  permissions,
  maxToolCalls,
  onToolsChange,
  onPermissionsChange,
  onMaxToolCallsChange,
}: AgentToolsSectionProps) {
  const assigned = new Set(tools);
  const granted = new Set<string>(["READ", ...permissions]);
  const builtinGroups = Object.entries(CATEGORY_LABELS)
    .filter(([category]) => category !== "mcp")
    .map(([category, label]) => ({ key: category, label, tools: available.filter((t) => t.category === category) }));
  const mcpTools = available.filter((t) => t.category === "mcp");
  const mcpGroups = [...new Map(mcpTools.map((t) => [t.server?.id ?? "", t.server])).entries()].map(([id, server]) => ({
    key: `mcp-${id}`,
    label: `MCP · ${server?.name ?? "Unknown server"}`,
    tools: mcpTools.filter((t) => (t.server?.id ?? "") === id),
  }));
  const byCategory = [...builtinGroups, ...mcpGroups];
  const unknown = tools.filter((name) => !available.some((t) => t.name === name));

  const toggleTool = (name: string, on: boolean) =>
    onToolsChange(on ? [...new Set([...tools, name])] : tools.filter((t) => t !== name));
  const togglePermission = (permission: GrantablePermission, on: boolean) =>
    onPermissionsChange(on ? [...new Set([...permissions, permission])] : permissions.filter((p) => p !== permission));

  return (
    <div className="grid grid-cols-1 gap-5">
      <div className="grid grid-cols-1 gap-2">
        <p className="text-sm font-medium">Permissions</p>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <li className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <span>
              <span className="block text-sm">READ</span>
              <span className="block text-xs text-muted-foreground">Always allowed for assigned tools</span>
            </span>
            <Switch checked disabled aria-label="READ permission (always on)" />
          </li>
          {GRANTABLE_PERMISSIONS.map((permission) => (
            <li key={permission} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <span>
                <Label htmlFor={`perm-${permission}`} className="block text-sm">
                  {permission}
                </Label>
                <span className="block text-xs text-muted-foreground">{PERMISSION_HELP[permission]}</span>
              </span>
              <Switch id={`perm-${permission}`} checked={permissions.includes(permission)} onCheckedChange={(on) => togglePermission(permission, on)} />
            </li>
          ))}
          <li className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 sm:col-span-2">
            <span>
              <span className="block text-sm">DESTRUCTIVE</span>
              <span className="block text-xs text-muted-foreground">
                Deleting files, force pushes, stopping services. Never granted in advance: each attempt asks you to approve it.
              </span>
            </span>
            <Badge variant="outline" className="shrink-0 font-mono text-[0.65rem]">
              ASKS YOU
            </Badge>
          </li>
        </ul>
      </div>

      <div className="grid max-w-xs grid-cols-1 gap-1.5">
        <Label htmlFor="maxToolCalls">Maximum tool calls per task</Label>
        <Input
          id="maxToolCalls"
          type="number"
          min={AGENT_LIMITS.maxToolCalls.min}
          max={AGENT_LIMITS.maxToolCalls.max}
          value={Number.isFinite(maxToolCalls) ? maxToolCalls : ""}
          onChange={(e) => onMaxToolCallsChange(e.target.valueAsNumber)}
          required
        />
      </div>

      {byCategory.map(({ key, label, tools: group }) =>
        group.length === 0 ? null : (
          <div key={key} className="grid grid-cols-1 gap-2">
            <p className="text-sm font-medium">{label}</p>
            <ul className="grid grid-cols-1 divide-y rounded-lg border">
              {group.map((tool) => {
                const needs = tool.permission === "DYNAMIC" ? "EXECUTE" : tool.permission;
                const missingGrant = assigned.has(tool.name) && needs !== "DESTRUCTIVE" && !granted.has(needs);
                return (
                  <li key={tool.name} className={cn("flex items-start gap-3 px-3 py-2.5", !tool.available && "opacity-70")}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor={`tool-${tool.name}`} className="font-mono text-xs">
                          {tool.name}
                        </Label>
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-mono text-[0.6rem]",
                            needs === "DESTRUCTIVE" && "border-destructive/40 text-destructive",
                          )}
                        >
                          {tool.permission === "DYNAMIC" ? "EXECUTE / DESTRUCTIVE" : tool.permission}
                        </Badge>
                        {!tool.available && (
                          <Badge variant="outline" className="border-warning/40 bg-warning/10 text-[0.6rem] text-foreground">
                            Unavailable
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{tool.description}</p>
                      {!tool.available && tool.unavailableReason && <p className="mt-0.5 text-xs text-warning">{tool.unavailableReason}</p>}
                      {needs === "DESTRUCTIVE" && assigned.has(tool.name) && (
                        <p className="mt-1 text-xs text-muted-foreground">Each use pauses the task until you approve it.</p>
                      )}
                      {missingGrant && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-warning">
                          <AlertTriangleIcon className="size-3.5" /> Needs the {needs} permission; calls will be denied.
                        </p>
                      )}
                    </div>
                    <Switch id={`tool-${tool.name}`} checked={assigned.has(tool.name)} onCheckedChange={(on) => toggleTool(tool.name, on)} />
                  </li>
                );
              })}
            </ul>
          </div>
        ),
      )}

      {mcpGroups.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No MCP tools yet.{" "}
          <Link href="/mcp" className="underline underline-offset-2 hover:text-foreground">
            Add an MCP server
          </Link>{" "}
          to assign its tools here.
        </p>
      )}

      {unknown.length > 0 && (
        <p className="text-xs text-warning">Assigned tools not available on this server: {unknown.join(", ")}.</p>
      )}
    </div>
  );
}
