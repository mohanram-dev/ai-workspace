"use client";

import { NEVER_AUTONOMOUS, type ToolInfoDto } from "@aiw/shared";
import { ShieldAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface AutonomousSectionProps {
  available: ToolInfoDto[];
  /** Tools assigned to this agent; only these can be trusted. */
  assigned: string[];
  autonomousMode: boolean;
  trustedTools: string[];
  onAutonomousModeChange: (value: boolean) => void;
  onTrustedToolsChange: (value: string[]) => void;
}

/**
 * Autonomous mode (spec §27). Only DESTRUCTIVE tools are listed: everything
 * else already runs without a prompt once the permission is granted, so
 * trusting it would change nothing.
 */
export function AutonomousSection({
  available,
  assigned,
  autonomousMode,
  trustedTools,
  onAutonomousModeChange,
  onTrustedToolsChange,
}: AutonomousSectionProps) {
  const assignedSet = new Set(assigned);
  const mine = available.filter((tool) => assignedSet.has(tool.name));
  // The floor is matched by name: its tools report a DYNAMIC permission (it
  // depends on the command), so a permission filter alone would hide them.
  const blocked = mine.filter((tool) => NEVER_AUTONOMOUS.includes(tool.name));
  // Only a tool that can be destructive is worth trusting; DYNAMIC ones off the
  // floor can be too, since the runtime classifies each call.
  const trustable = mine.filter((tool) => !NEVER_AUTONOMOUS.includes(tool.name) && (tool.permission === "DESTRUCTIVE" || tool.permission === "DYNAMIC"));

  function toggle(name: string, on: boolean) {
    onTrustedToolsChange(on ? [...new Set([...trustedTools, name])] : trustedTools.filter((t) => t !== name));
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-start justify-between gap-3">
        <span>
          <Label htmlFor="autonomous-mode" className="block text-sm">
            Run unattended
          </Label>
          <span className="block text-xs text-muted-foreground">
            The agent performs the trusted actions below without stopping to ask. Everything else still waits for you.
          </span>
        </span>
        <Switch id="autonomous-mode" checked={autonomousMode} onCheckedChange={onAutonomousModeChange} />
      </div>

      {autonomousMode && (
        <>
          {trustable.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None of this agent&apos;s tools can be trusted. Assign a destructive tool first, or leave autonomous mode off.
            </p>
          ) : (
            <div className="grid gap-2">
              <p className="text-xs font-medium">Trusted actions</p>
              {trustable.map((tool) => (
                <div key={tool.name} className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-mono text-xs">{tool.name}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{tool.description}</span>
                  </span>
                  <Switch
                    checked={trustedTools.includes(tool.name)}
                    onCheckedChange={(on) => toggle(tool.name, on)}
                    aria-label={`Trust ${tool.name}`}
                  />
                </div>
              ))}
            </div>
          )}

          {blocked.length > 0 && (
            <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <ShieldAlertIcon className="size-3.5" /> Always asks, even unattended
              </p>
              <ul className="mt-1.5 grid gap-1">
                {blocked.map((tool) => (
                  <li key={tool.name} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline" className="font-mono text-[0.6rem]">
                      {tool.name}
                    </Badge>
                    runs arbitrary commands, so it can deploy, delete or read secrets
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Every unattended action is written to the task timeline and the audit log, so you can see afterwards exactly what ran.
          </p>
        </>
      )}
    </div>
  );
}
