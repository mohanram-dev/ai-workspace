import { getDatabase, listMcpToolNamesForUser } from "@aiw/database";
import { randomBytes } from "node:crypto";
import { HttpError } from "./http";
import { getProviderRegistry } from "./providers";
import { getToolRegistry } from "./tools";

/** Ensures the provider exists and a pinned model is offered by it. */
export async function validateAgentModel(providerId: string, model: string | null): Promise<void> {
  const provider = getProviderRegistry().get(providerId);
  if (!provider) throw new HttpError(400, "bad_request", `Unknown model provider "${providerId}".`);
  if (model === null) return;
  if (!provider.isConfigured()) {
    throw new HttpError(400, "bad_request", `${provider.name} is not configured, so a specific model cannot be selected.`);
  }
  const models = await provider.listModels();
  if (!models.some((m) => m.id === model)) {
    throw new HttpError(400, "bad_request", `Model "${model}" is not available.`);
  }
}

/** Ensures every assigned tool is a built-in tool or one of the user's MCP tools. */
export async function validateAgentTools(userId: string, tools: string[]): Promise<void> {
  const registry = getToolRegistry();
  const candidates = tools.filter((name) => !registry.has(name));
  const mcp = candidates.length ? new Set(await listMcpToolNamesForUser(getDatabase(), userId, candidates)) : new Set<string>();
  const unknown = candidates.filter((name) => !mcp.has(name));
  if (unknown.length > 0) throw new HttpError(400, "bad_request", `Unknown tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
}

/** URL-safe unique slug for a custom agent, e.g. "seo-writer-3f9a". */
export function customAgentSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "agent"}-${randomBytes(2).toString("hex")}`;
}
