import { NEVER_AUTONOMOUS } from "@aiw/shared";
import type { PermissionLevel } from "./types";

export type PermissionDecision =
  | { outcome: "allowed"; autonomous?: boolean }
  /** A human must approve this action before it runs (spec §16–17). */
  | { outcome: "needs_approval"; message: string }
  | { outcome: "denied"; reason: "not_granted"; message: string };

// The floor itself lives in @aiw/shared so the agent editor (browser code) can
// show it without pulling this package's Node dependencies into the bundle.
export { NEVER_AUTONOMOUS };

export interface AutonomousSettings {
  enabled: boolean;
  /** Tool names the user has marked trusted for this agent. */
  trustedTools: readonly string[];
}

/** Whether a tool may be trusted at all, for the agent editor and for enforcement. */
export function canBeTrusted(toolName: string): boolean {
  return !NEVER_AUTONOMOUS.includes(toolName);
}

/**
 * Spec §16: READ is automatically allowed; WRITE, EXECUTE and NETWORK must be
 * granted to the agent; DESTRUCTIVE always requires human approval.
 *
 * `approvedForTask` holds tool names the user already approved for the whole
 * task ("Approve for this task"), which skips further prompts for that tool.
 *
 * `autonomous` (spec §27) lets a user pre-approve named tools so the agent runs
 * unattended. It never widens the floor above, and it is recorded on the
 * timeline and in the audit log so an unattended action is still visible.
 */
export function decidePermission(
  level: PermissionLevel,
  granted: readonly string[],
  options: {
    toolName?: string;
    approvedForTask?: readonly string[];
    autonomous?: AutonomousSettings;
  } = {},
): PermissionDecision {
  if (level === "READ") return { outcome: "allowed" };
  if (level === "DESTRUCTIVE") {
    if (options.toolName && options.approvedForTask?.includes(options.toolName)) return { outcome: "allowed" };
    if (options.toolName && isAutonomouslyTrusted(options.toolName, options.autonomous)) {
      return { outcome: "allowed", autonomous: true };
    }
    return { outcome: "needs_approval", message: "This action is DESTRUCTIVE, so it needs human approval before it can run." };
  }
  if (granted.includes(level)) return { outcome: "allowed" };
  return {
    outcome: "denied",
    reason: "not_granted",
    message: `This action needs the ${level} permission, which this agent has not been granted.`,
  };
}

function isAutonomouslyTrusted(toolName: string, autonomous: AutonomousSettings | undefined): boolean {
  if (!autonomous?.enabled) return false;
  if (!canBeTrusted(toolName)) return false;
  return autonomous.trustedTools.includes(toolName);
}
