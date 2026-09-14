import type { PermissionLevel } from "@aiw/tools";

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Default permission for a discovered tool. Annotations are hints from the
 * server, not guarantees, so users can override the level per tool:
 * - `destructiveHint: true` → DESTRUCTIVE (blocked until approvals exist)
 * - `readOnlyHint: true` → READ
 * - anything else → EXECUTE: an arbitrary action on an external system must be granted.
 */
export function defaultPermissionFor(annotations: McpToolAnnotations | null | undefined): PermissionLevel {
  if (annotations?.destructiveHint === true) return "DESTRUCTIVE";
  if (annotations?.readOnlyHint === true) return "READ";
  return "EXECUTE";
}

export function effectivePermission(tool: { permission: string | null; defaultPermission: string }): PermissionLevel {
  return (tool.permission ?? tool.defaultPermission) as PermissionLevel;
}

/** Keeps only the known annotation fields with the right types. */
export function pickAnnotations(value: unknown): McpToolAnnotations | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const result: McpToolAnnotations = {};
  if (typeof source.title === "string") result.title = source.title.slice(0, 200);
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    if (typeof source[key] === "boolean") result[key] = source[key];
  }
  return Object.keys(result).length > 0 ? result : null;
}
