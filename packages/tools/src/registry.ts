import { z } from "zod";
import type { AnyToolDefinition, PermissionLevel, ToolAvailability, ToolCategory } from "./types";

export interface ToolInfo {
  name: string;
  description: string;
  category: ToolCategory;
  /** Static level, or "DYNAMIC" when it depends on the input (e.g. terminal commands). */
  permission: PermissionLevel | "DYNAMIC";
  available: boolean;
  unavailableReason: string | null;
}

/** JSON Schema for model function calling, without draft metadata providers reject. */
export function toolParameters(tool: AnyToolDefinition): Record<string, unknown> {
  if (tool.parameters) return tool.parameters;
  const schema = z.toJSONSchema(tool.inputSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  constructor(tools: AnyToolDefinition[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AnyToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  availability(name: string): ToolAvailability {
    const tool = this.tools.get(name);
    return tool ? tool.availability() : { available: false, reason: "Unknown tool." };
  }

  describe(): ToolInfo[] {
    return this.list().map((tool) => {
      const availability = tool.availability();
      return {
        name: tool.name,
        description: tool.description,
        category: tool.category,
        permission: typeof tool.permission === "function" ? "DYNAMIC" : tool.permission,
        available: availability.available,
        unavailableReason: availability.available ? null : (availability.reason ?? "Unavailable."),
      };
    });
  }

  /** Assigned tools that are currently usable, in registration order. */
  resolve(names: readonly string[]): AnyToolDefinition[] {
    const wanted = new Set(names);
    return this.list().filter((tool) => wanted.has(tool.name) && tool.availability().available);
  }
}
