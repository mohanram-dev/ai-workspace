import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The composition root caches everything: the env in module state, the
 * services on globalThis. Each test therefore starts from a fresh module
 * graph (vi.resetModules + dynamic import) and a clean set of globals, so
 * what it asserts is what a freshly started process would do.
 */

const GLOBAL_KEYS = ["__aiwDb", "__aiwProviders", "__aiwTools", "__aiwBrowser", "__aiwComputer", "__aiwMcp", "__aiwAgents", "__aiwQueue", "__aiwScheduler"] as const;

/** The smallest environment that validates. */
const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://aiw:aiw@localhost:5432/aiw_test",
  APP_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "x".repeat(48),
};

const originalEnv = { ...process.env };

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadEnv(values: Record<string, string | undefined>) {
  setEnv({ ...BASE_ENV, ...values });
  vi.resetModules();
  const { getServerEnv } = await import("../src/env");
  return getServerEnv();
}

beforeEach(() => {
  for (const key of GLOBAL_KEYS) delete (globalThis as Record<string, unknown>)[key];
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  for (const key of GLOBAL_KEYS) delete (globalThis as Record<string, unknown>)[key];
});

describe("getServerEnv", () => {
  it("fails fast and names the missing variable", async () => {
    setEnv({ ...BASE_ENV, BETTER_AUTH_SECRET: undefined });
    vi.resetModules();
    const { getServerEnv } = await import("../src/env");
    expect(() => getServerEnv()).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("rejects a secret that is too short to be safe", async () => {
    await expect(loadEnv({ BETTER_AUTH_SECRET: "short" })).rejects.toThrow(/at least 32 characters/);
  });

  it("applies the documented defaults", async () => {
    const env = await loadEnv({});
    expect(env.TERMINAL_ENABLED).toBe(false);
    expect(env.DOCKER_TOOLS_ENABLED).toBe(false);
    expect(env.SSH_TOOLS_ENABLED).toBe(false);
    expect(env.COMPUTER_USE_ENABLED).toBe(false);
    expect(env.ALLOW_REGISTRATION).toBe(false);
    expect(env.DELEGATION_ENABLED).toBe(true);
    expect(env.MAX_DELEGATION_DEPTH).toBe(1);
    expect(env.MAX_RUNNING_TASKS_PER_USER).toBe(3);
    expect(env.WORKSPACE_ROOT).toBe("./data/workspaces");
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.RUN_SCHEDULER).toBe(true);
  });

  it("parses the list and boolean transforms", async () => {
    const env = await loadEnv({
      TERMINAL_ENABLED: "true",
      TERMINAL_ALLOWED_COMMANDS: " ls , git ,,node ",
      GEMINI_MODELS: "a, b",
      SSH_HOSTS: "web=deploy@10.0.0.5:2222, db=pg@db.internal",
    });
    expect(env.TERMINAL_ENABLED).toBe(true);
    expect(env.TERMINAL_ALLOWED_COMMANDS).toEqual(["ls", "git", "node"]);
    expect(env.GEMINI_MODELS).toEqual(["a", "b"]);
    expect(env.SSH_HOSTS).toEqual([
      { name: "web", destination: "deploy@10.0.0.5", port: 2222 },
      { name: "db", destination: "pg@db.internal" },
    ]);
  });

  it("treats an empty optional value as unset", async () => {
    const env = await loadEnv({ GEMINI_API_KEY: "", REDIS_URL: "" });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
  });

  it("refuses values outside their documented range", async () => {
    await expect(loadEnv({ MAX_DELEGATION_DEPTH: "9" })).rejects.toThrow(/MAX_DELEGATION_DEPTH/);
    await expect(loadEnv({ WEB_SEARCH_PROVIDER: "bing" })).rejects.toThrow(/WEB_SEARCH_PROVIDER/);
  });

  it("caches the first successful parse", async () => {
    setEnv(BASE_ENV);
    vi.resetModules();
    const { getServerEnv } = await import("../src/env");
    const first = getServerEnv();
    process.env.MAX_RUNNING_TASKS_PER_USER = "42";
    expect(getServerEnv()).toBe(first);
    expect(getServerEnv().MAX_RUNNING_TASKS_PER_USER).toBe(3);
  });
});

describe("getQueueRuntime", () => {
  it("is null without REDIS_URL: single-process mode is the default, not a fallback", async () => {
    setEnv(BASE_ENV);
    vi.resetModules();
    const { getQueueRuntime } = await import("../src/queue");
    expect(getQueueRuntime()).toBeNull();
    // Cached as null, so a later call does not re-read the environment.
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    expect(getQueueRuntime()).toBeNull();
  });
});

describe("getAgentServices (single-process mode)", () => {
  it("wires an in-process executor, an in-memory bus and the delegation tool", async () => {
    setEnv(BASE_ENV);
    vi.resetModules();
    const [{ getAgentServices }, { getToolRegistry }, agents] = await Promise.all([
      import("../src/agents"),
      import("../src/tools"),
      import("@aiw/agents"),
    ]);

    const services = getAgentServices();
    expect(services.queued).toBe(false);
    expect(services.executor).toBeInstanceOf(agents.InProcessTaskExecutor);
    expect(services.bus).toBeInstanceOf(agents.InMemoryTaskEventBus);
    expect(services.runtime).toBeInstanceOf(agents.AgentRuntime);
    expect(services.tasks).toBeInstanceOf(agents.TaskService);

    // The runtime owns agent.delegate; registering it is what lists it for assignment.
    expect(getToolRegistry().has("agent.delegate")).toBe(true);
    // Built-ins are all present, and the dangerous ones report why they are off.
    const registry = getToolRegistry();
    expect(registry.has("files.read")).toBe(true);
    expect(registry.availability("terminal.run")).toMatchObject({ available: false });
    expect(registry.availability("docker.ps")).toMatchObject({ available: false });

    // A second call is the same object: one set of services per process.
    expect(getAgentServices()).toBe(services);
  });

  it("honours DELEGATION_ENABLED=false by not offering the tool", async () => {
    setEnv({ ...BASE_ENV, DELEGATION_ENABLED: "false" });
    vi.resetModules();
    const [{ getAgentServices }, { getToolRegistry }] = await Promise.all([import("../src/agents"), import("../src/tools")]);
    getAgentServices();
    expect(getToolRegistry().has("agent.delegate")).toBe(false);
  });
});
