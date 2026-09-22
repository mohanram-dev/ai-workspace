import { parseSshHosts } from "@aiw/tools";
import { z } from "zod";

/** Treat empty strings (e.g. `GEMINI_API_KEY=` in .env) as unset. */
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());

/**
 * OpenRouter models offered when `OPENROUTER_MODELS` is not set — the two the
 * owner chose. Both were verified against the live API (2026-09-22) on all
 * four paths the app needs: plain streaming, a tool call, `json_schema`
 * output, and the real 8-agent router prompt. Prices are per 1M tokens in/out.
 *
 * `qwen/qwen3.7-flash` does **not** advertise `structured_outputs` in
 * OpenRouter's model metadata, yet returns valid schema-shaped JSON. The
 * declared capability list is therefore a hint, not the answer — check a model
 * before trusting or rejecting it on that field alone.
 *
 * Note for anyone adding a model here: a reasoning model can return
 * `finish_reason: "stop"` with **empty content** once the prompt is long
 * enough, having spent its whole output budget thinking. `openai/gpt-oss-20b`
 * does exactly that on the router prompt (94 output tokens, all reasoning),
 * and nothing errors — routing silently falls back to the general agent. The
 * 120b sibling below does not. Always test against the router prompt, not just
 * a short question.
 */
const DEFAULT_OPENROUTER_MODELS = [
  "qwen/qwen3.7-flash", //     $0.030 / $0.130, 1M context
  "openai/gpt-oss-120b", //    $0.150 / $0.600, 131k context
];

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url(),
  APP_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  GEMINI_API_KEY: optionalString,
  GEMINI_DEFAULT_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  /** Comma-separated model ids offered in the picker. Empty = all available text models. */
  GEMINI_MODELS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  // OpenAI-compatible provider (spec §13): vLLM, Ollama, LiteLLM, OpenRouter,
  // a self-hosted gateway, or OpenAI itself. The base URL is operator
  // configuration, so a private/LAN address is expected and allowed here.
  /** Base URL including the version path, e.g. http://10.0.0.5:8000/v1. Unset = provider off. */
  OPENAI_BASE_URL: optionalString,
  /** Optional: local gateways often need no key. */
  OPENAI_API_KEY: optionalString,
  OPENAI_DEFAULT_MODEL: optionalString,
  /** Models offered in the picker (comma-separated). A gateway may advertise hundreds. */
  OPENAI_MODELS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  /** Display name, so a self-hosted gateway reads as itself. */
  OPENAI_PROVIDER_NAME: optionalString,
  // OpenRouter (spec §13): the same chat-completions protocol, but a hosted
  // service with its own key and hundreds of models behind one account. It is
  // registered separately from OPENAI_* so a LAN gateway and OpenRouter can
  // both be available at once.
  /** OpenRouter key (https://openrouter.ai/keys). Unset = the provider is off. */
  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  /** Default model: the cheaper of the two, with far more context. */
  OPENROUTER_DEFAULT_MODEL: z.string().min(1).default("qwen/qwen3.7-flash"),
  /**
   * Models offered in the picker (comma-separated). OpenRouter advertises 400+,
   * so the default is a small verified set: each one streams, calls tools and
   * honours `json_schema`, which the planner needs. Cheapest first.
   */
  OPENROUTER_MODELS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? DEFAULT_OPENROUTER_MODELS.join(","))
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  /** Sent to OpenRouter for app attribution on its rankings. Optional. */
  OPENROUTER_APP_NAME: optionalString,
  /** Which provider agents use when they do not name one. */
  DEFAULT_PROVIDER: z.enum(["gemini", "openai-compatible", "openrouter"]).default("gemini"),

  ALLOW_REGISTRATION: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** Model used by the automatic agent router. Defaults to GEMINI_DEFAULT_MODEL. */
  ROUTER_MODEL: optionalString,
  MAX_RUNNING_TASKS_PER_USER: z.coerce.number().int().min(1).max(50).default(3),
  /** Base directory for per-user tool workspaces; relative paths resolve from the repository root. */
  WORKSPACE_ROOT: z.string().min(1).default("./data/workspaces"),
  TERMINAL_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  TERMINAL_ALLOWED_COMMANDS: z
    .string()
    .default("ls,cat,echo,pwd,grep,find,wc,head,tail,du,df,git,node,npm,python3")
    .transform((v) =>
      v
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
    ),
  TERMINAL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(600).default(60),
  WEB_SEARCH_PROVIDER: z.enum(["gemini", "searxng", "none"]).default("gemini"),
  /** Gemini model for grounded search (grounding availability differs by model and plan). */
  WEB_SEARCH_MODEL: z.string().min(1).default("gemini-2.5-flash-lite"),
  SEARXNG_URL: optionalString,
  WEB_FETCH_ALLOW_PRIVATE_NETWORK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Infrastructure tools (spec §15). Each touches this host or a real account,
  // so each is off until switched on.
  /** Docker tools run the docker CLI on this host. */
  DOCKER_TOOLS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  DOCKER_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(600).default(60),
  /** SSH tools run commands on the hosts named below. */
  SSH_TOOLS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Hosts an agent may reach: name=user@host:port, comma separated. */
  SSH_HOSTS: z.string().default("").transform(parseSshHosts),
  SSH_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(600).default(60),
  /** GitHub token for the github.* tools. Without it they work but are rate limited. */
  GITHUB_TOKEN: optionalString,
  GITHUB_API_URL: optionalString,

  /** stdio MCP servers run commands on this host; only administrators can add them, and only when enabled. */
  MCP_STDIO_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** How long an approval request stays open before it expires. */
  APPROVAL_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),

  // Production (spec §44). Without REDIS_URL the whole app runs in one process.
  /** Redis connection. Set it to run tasks in a separate worker tier. */
  REDIS_URL: optionalString,
  /** Tasks one worker process runs at once. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(3),
  /** Which process runs the schedule ticker: the worker in queue mode, otherwise the web server. */
  RUN_SCHEDULER: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Agent-to-agent delegation (spec §28).
  DELEGATION_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  MAX_DELEGATION_DEPTH: z.coerce.number().int().min(0).max(3).default(1),
  MAX_DELEGATIONS_PER_TASK: z.coerce.number().int().min(1).max(20).default(5),
  MAX_SUBTASK_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  /** Computer use: control the server's real desktop (mouse/keyboard/screen). Off by default; not a sandbox. */
  COMPUTER_USE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  COMPUTER_MAX_WIDTH: z.coerce.number().int().min(320).max(3840).default(1280),
  /** Agent browser (headless Chromium via Playwright). */
  BROWSER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Use an installed browser ("chrome" or "msedge") instead of Playwright's Chromium. */
  BROWSER_CHANNEL: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["chrome", "msedge", "chromium"]).optional()),
  BROWSER_EXECUTABLE_PATH: optionalString,
  BROWSER_MAX_SESSIONS: z.coerce.number().int().min(1).max(20).default(3),
  BROWSER_ALLOW_PRIVATE_NETWORK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Allow http MCP servers on loopback / private network addresses (e.g. a local Docker MCP server). */
  MCP_ALLOW_PRIVATE_NETWORK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | undefined;

/**
 * Validated server environment. Parsed lazily so `next build` does not
 * require runtime secrets; the first request fails fast if misconfigured.
 */
export function getServerEnv(): ServerEnv {
  if (!cached) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      throw new Error(`Invalid server environment:\n${issues}`);
    }
    cached = result.data;
  }
  return cached;
}
