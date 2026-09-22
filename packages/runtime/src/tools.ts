import { existsSync } from "node:fs";
import path from "node:path";
import type { GeminiProvider } from "@aiw/ai";
import { createBuiltinToolRegistry, SearxngSearchService, type ToolRegistry, type WebSearchService } from "@aiw/tools";
import { getDatabase } from "@aiw/database";
import { createMemoryTools } from "@aiw/agents";
import { createScheduleTools } from "@aiw/scheduler";
import { getBrowserTools } from "./browser";
import { getComputerTools } from "./computer";
import { getServerEnv, type ServerEnv } from "./env";
import { getProviderRegistry } from "./providers";

/** Web search through Gemini's Google Search grounding (plan and quota dependent). */
class GeminiGroundedSearchService implements WebSearchService {
  readonly name = "Gemini Google Search";

  constructor(
    private readonly provider: GeminiProvider,
    private readonly model: string,
  ) {}

  availability() {
    return this.provider.isConfigured() ? { available: true } : { available: false, reason: "GEMINI_API_KEY is not set." };
  }

  async search(query: string, signal: AbortSignal) {
    const result = await this.provider.groundedSearch(query, { model: this.model, signal });
    return {
      answer: result.answer || null,
      results: result.sources,
      usage: { provider: this.provider.id, model: result.model, ...result.usage },
    };
  }
}

function createSearchService(env: ServerEnv): WebSearchService | null {
  if (env.WEB_SEARCH_PROVIDER === "none") return null;
  if (env.WEB_SEARCH_PROVIDER === "searxng") return env.SEARXNG_URL ? new SearxngSearchService(env.SEARXNG_URL) : null;
  const gemini = getProviderRegistry().get("gemini") as GeminiProvider | undefined;
  return gemini ? new GeminiGroundedSearchService(gemini, env.WEB_SEARCH_MODEL) : null;
}

/** Repository root (directory with pnpm-workspace.yaml), used to resolve relative paths. */
function repositoryRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export function getWorkspaceRoot(): string {
  const configured = getServerEnv().WORKSPACE_ROOT;
  return path.isAbsolute(configured) ? configured : path.resolve(repositoryRoot(), configured);
}

const globalForTools = globalThis as unknown as { __aiwTools?: ToolRegistry };

export function getToolRegistry(): ToolRegistry {
  if (!globalForTools.__aiwTools) {
    const env = getServerEnv();
    globalForTools.__aiwTools = createBuiltinToolRegistry({
      terminal: {
        enabled: env.TERMINAL_ENABLED,
        allowedCommands: env.TERMINAL_ALLOWED_COMMANDS,
        defaultTimeoutMs: env.TERMINAL_TIMEOUT_SECONDS * 1000,
      },
      web: { allowPrivateNetwork: env.WEB_FETCH_ALLOW_PRIVATE_NETWORK, search: createSearchService(env) },
      docker: { enabled: env.DOCKER_TOOLS_ENABLED, timeoutMs: env.DOCKER_TIMEOUT_SECONDS * 1000 },
      ssh: { enabled: env.SSH_TOOLS_ENABLED, hosts: env.SSH_HOSTS, timeoutMs: env.SSH_TIMEOUT_SECONDS * 1000 },
      github: { token: env.GITHUB_TOKEN, ...(env.GITHUB_API_URL ? { apiBaseUrl: env.GITHUB_API_URL } : {}) },
    });
    for (const tool of getBrowserTools()) globalForTools.__aiwTools.register(tool);
    for (const tool of getComputerTools()) globalForTools.__aiwTools.register(tool);
    for (const tool of createMemoryTools(getDatabase())) globalForTools.__aiwTools.register(tool);
    for (const tool of createScheduleTools({ db: getDatabase() })) globalForTools.__aiwTools.register(tool);
  }
  return globalForTools.__aiwTools;
}
