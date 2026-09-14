import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgent,
  createDatabase,
  createMcpServer,
  deleteMcpServerForUser,
  getAgentForUser,
  getMcpServerForUser,
  listMcpToolsForServer,
  schema,
  updateMcpServerForUser,
  updateMcpToolForUser,
  type DatabaseHandle,
  type McpServer,
} from "@aiw/database";
import { getTestDatabaseUrl } from "@aiw/database/testing";
import { Workspace, type ToolActivity, type ToolContext } from "@aiw/tools";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  convertToolResult,
  defaultPermissionFor,
  McpConnectionManager,
  McpToolSource,
  pickAnnotations,
  refreshMcpServer,
  SecretBox,
  type McpConnectionConfig,
} from "../src";

const SERVER_SCRIPT = fileURLToPath(new URL("./fixtures/test-server.mjs", import.meta.url));
const SECRET = "test-secret-that-is-at-least-32-characters-long";

function stdioConfig(overrides: Partial<McpConnectionConfig> = {}): McpConnectionConfig {
  return { id: randomUUID(), name: "Test stdio", transport: "stdio", command: process.execPath, args: [SERVER_SCRIPT, "stdio"], url: null, headers: {}, env: {}, ...overrides };
}

async function startHttpServer(token?: string): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(process.execPath, [SERVER_SCRIPT, "http", "0", ...(token ? [token] : [])]);
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.on("data", (data: Buffer) => {
      const match = /listening (\d+)/.exec(String(data));
      if (match) resolve(Number(match[1]));
    });
    child.on("error", reject);
  });
  return { url: `http://127.0.0.1:${port}/mcp`, child };
}

function firstText(result: { content: unknown[] }): string {
  const block = result.content[0] as { type?: string; text?: string } | undefined;
  return block?.type === "text" ? String(block.text) : "";
}

function fakeContext(workspaceRoot: string, signal = new AbortController().signal) {
  const activities: ToolActivity[] = [];
  const ctx: ToolContext = {
    taskId: randomUUID(),
    userId: "user",
    workspace: new Workspace(workspaceRoot),
    signal,
    report: (activity) => activities.push(activity),
    output: () => {},
  };
  return { ctx, activities };
}

describe("SecretBox", () => {
  it("round-trips, detects tampering and other keys, and applies write-only updates", () => {
    const box = new SecretBox(SECRET);
    const encrypted = box.encrypt("ghp_secret");
    expect(encrypted).not.toContain("ghp_secret");
    expect(box.encrypt("ghp_secret")).not.toBe(encrypted);
    expect(box.decrypt(encrypted)).toBe("ghp_secret");

    const parts = encrypted.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => box.decrypt(parts.join(":"))).toThrow(/could not be decrypted/);
    expect(() => new SecretBox(`${SECRET}-other`).decrypt(encrypted)).toThrow(/could not be decrypted/);

    const stored = box.encryptMap({ A: "1", B: "2" });
    const next = box.applyUpdate(stored, { A: null, C: "3" });
    expect(next.B).toBe(stored.B);
    expect(box.decryptMap(next)).toEqual({ B: "2", C: "3" });
  });
});

describe("permissions and results", () => {
  it("derives default permissions from annotations", () => {
    expect(defaultPermissionFor({ readOnlyHint: true })).toBe("READ");
    expect(defaultPermissionFor({ destructiveHint: true, readOnlyHint: true })).toBe("DESTRUCTIVE");
    expect(defaultPermissionFor({})).toBe("EXECUTE");
    expect(defaultPermissionFor(null)).toBe("EXECUTE");
    expect(pickAnnotations({ readOnlyHint: true, destructiveHint: "yes", extra: 1 })).toEqual({ readOnlyHint: true });
    expect(pickAnnotations("nope")).toBeNull();
  });

  it("converts content blocks, keeps binary out of model text and flags errors", () => {
    const converted = convertToolResult({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: Buffer.from("12345678").toString("base64"), mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///a.txt", text: "resource body" } },
        { type: "resource_link", uri: "https://example.com/x", name: "x" },
      ],
    });
    expect(converted.text).toContain("hello");
    expect(converted.text).toContain("[image image/png, 8 bytes: not shown to the model]");
    expect(converted.text).toContain("resource body");
    expect(JSON.stringify(converted.output)).not.toContain(Buffer.from("12345678").toString("base64"));
    expect(convertToolResult({ content: [], structuredContent: { sum: 5 } }).text).toBe('{"sum":5}');
    expect(convertToolResult({ content: [{ type: "text", text: "bad" }], isError: true }).isError).toBe(true);
  });
});

describe("McpConnectionManager over stdio", () => {
  let manager: McpConnectionManager;
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "aiw-mcp-cwd-"));
  });
  afterEach(async () => {
    await manager?.closeAll();
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("discovers and calls tools, reuses the connection and isolates the environment", async () => {
    manager = new McpConnectionManager({ stdioEnabled: true, allowPrivateNetwork: false });
    process.env.AIW_SERVER_SECRET = "must-not-leak";
    try {
      const config = stdioConfig({ env: { MCP_TEST_TOKEN: "configured" }, cwd });
      const { tools, server } = await manager.listTools(config);
      expect(server).toEqual({ name: "aiw-test-server", version: "1.2.3" });
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["echo", "add", "write_note", "delete_note", "fail", "slow", "env"]));
      expect(tools.find((t) => t.name === "delete_note")?.annotations).toMatchObject({ destructiveHint: true });

      const signal = new AbortController().signal;
      const added = await manager.callTool(config, "add", { a: 2, b: 40 }, { signal, timeoutMs: 10_000 });
      expect(added.structuredContent).toEqual({ sum: 42 });

      const env = JSON.parse(firstText(await manager.callTool(config, "env", {}, { signal, timeoutMs: 10_000 })));
      expect(env).toMatchObject({ token: "configured", leaked: null });
      expect(path.resolve(env.cwd)).toBe(path.resolve(cwd));

      const again = JSON.parse(firstText(await manager.callTool(config, "env", {}, { signal, timeoutMs: 10_000 })));
      expect(again.pid).toBe(env.pid);
      expect(manager.size).toBe(1);

      // A configuration change reconnects with the new settings.
      const changed = JSON.parse(
        firstText(await manager.callTool({ ...config, env: { MCP_TEST_TOKEN: "rotated" } }, "env", {}, { signal, timeoutMs: 10_000 })),
      );
      expect(changed.token).toBe("rotated");
      expect(changed.pid).not.toBe(env.pid);
      expect(manager.size).toBe(1);
    } finally {
      delete process.env.AIW_SERVER_SECRET;
    }
  });

  it("returns tool errors, supports cancellation and time limits", async () => {
    manager = new McpConnectionManager({ stdioEnabled: true, allowPrivateNetwork: false });
    const config = stdioConfig();
    const failed = await manager.callTool(config, "fail", {}, { signal: new AbortController().signal, timeoutMs: 10_000 });
    expect(failed.isError).toBe(true);

    const invalid = await manager.callTool(config, "echo", { text: 5 }, { signal: new AbortController().signal, timeoutMs: 10_000 });
    expect(invalid.isError).toBe(true);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await expect(manager.callTool(config, "slow", { ms: 10_000 }, { signal: controller.signal, timeoutMs: 20_000 })).rejects.toBeTruthy();
    expect(controller.signal.aborted).toBe(true);

    // The server stays usable after a cancelled call.
    const echo = await manager.callTool(config, "echo", { text: "still here" }, { signal: new AbortController().signal, timeoutMs: 10_000 });
    expect(echo.content[0]).toMatchObject({ text: "echo: still here" });
  });

  it("refuses stdio when disabled and reports missing commands", async () => {
    manager = new McpConnectionManager({ stdioEnabled: false, allowPrivateNetwork: false });
    await expect(manager.listTools(stdioConfig())).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/MCP_STDIO_ENABLED/) });

    manager = new McpConnectionManager({ stdioEnabled: true, allowPrivateNetwork: false, connectTimeoutMs: 10_000 });
    await expect(manager.listTools(stdioConfig({ command: "aiw-no-such-command-xyz", args: [] }))).rejects.toMatchObject({ code: "unavailable" });
    expect(manager.size).toBe(0);
  });
});

describe("McpConnectionManager over Streamable HTTP", () => {
  let server: { url: string; child: ChildProcess };
  let manager: McpConnectionManager;

  beforeAll(async () => {
    server = await startHttpServer("http-token");
  });
  afterEach(async () => {
    await manager?.closeAll();
  });
  afterAll(() => {
    server.child.kill();
  });

  const httpConfig = (headers: Record<string, string>): McpConnectionConfig => ({
    id: randomUUID(),
    name: "Test http",
    transport: "http",
    command: null,
    args: [],
    url: server.url,
    headers,
    env: {},
  });

  it("blocks private addresses unless allowed", async () => {
    manager = new McpConnectionManager({ stdioEnabled: false, allowPrivateNetwork: false });
    await expect(manager.listTools(httpConfig({ Authorization: "Bearer http-token" }))).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("sends configured headers and reports rejected credentials", async () => {
    manager = new McpConnectionManager({ stdioEnabled: false, allowPrivateNetwork: true });
    const { tools } = await manager.listTools(httpConfig({ Authorization: "Bearer http-token" }));
    expect(tools.length).toBeGreaterThan(5);
    const result = await manager.callTool(httpConfig({ Authorization: "Bearer http-token" }), "echo", { text: "over http" }, {
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });
    expect(result.content[0]).toMatchObject({ text: "echo: over http" });

    await expect(manager.listTools(httpConfig({ Authorization: "Bearer wrong" }))).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("discovery and tool source", () => {
  let handle: DatabaseHandle;
  let manager: McpConnectionManager;
  let workspaceRoot: string;
  const secrets = new SecretBox(SECRET);

  beforeAll(async () => {
    handle = createDatabase(getTestDatabaseUrl(), { max: 3 });
    manager = new McpConnectionManager({ stdioEnabled: true, allowPrivateNetwork: false });
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aiw-mcp-ws-"));
  });
  afterAll(async () => {
    await manager.closeAll();
    await handle.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function setup() {
    const userId = randomUUID();
    await handle.db.insert(schema.users).values({ id: userId, name: "MCP", email: `${userId}@example.test` });
    const server = (await createMcpServer(handle.db, {
      ownerId: userId,
      slug: "notes",
      name: "Notes server",
      transport: "stdio",
      command: process.execPath,
      args: [SERVER_SCRIPT, "stdio"],
      env: secrets.encryptMap({ MCP_TEST_TOKEN: "from-db" }),
    }))!;
    const services = { db: handle.db, manager, secrets, workspaceRoot };
    return { userId, server, services };
  }

  it("stores discovered tools with default permissions and keeps user overrides on refresh", async () => {
    const { userId, server, services } = await setup();
    expect(await createMcpServer(handle.db, { ownerId: userId, slug: "notes", name: "Dup", transport: "http", url: "https://x.test" })).toBeNull();

    const first = await refreshMcpServer(services, server);
    expect(first).toMatchObject({ ok: true, error: null, removed: 0 });
    expect(first.added).toBeGreaterThanOrEqual(7);

    const tools = await listMcpToolsForServer(handle.db, server.id);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.echo).toMatchObject({ defaultPermission: "READ", permission: null, enabled: true });
    expect(byName.write_note!.defaultPermission).toBe("EXECUTE");
    expect(byName.delete_note!.defaultPermission).toBe("DESTRUCTIVE");
    expect(byName.echo!.inputSchema).not.toHaveProperty("$schema");

    await updateMcpToolForUser(handle.db, userId, server.id, byName.write_note!.id, { permission: "WRITE", enabled: false });
    const second = await refreshMcpServer(services, server);
    expect(second).toMatchObject({ ok: true, added: 0, removed: 0 });
    const refreshed = (await listMcpToolsForServer(handle.db, server.id)).find((t) => t.name === "write_note");
    expect(refreshed).toMatchObject({ permission: "WRITE", enabled: false });

    const stored = await getMcpServerForUser(handle.db, userId, server.id);
    expect(stored).toMatchObject({ status: "connected", serverName: "aiw-test-server", serverVersion: "1.2.3", lastError: null });
    expect(stored!.toolCount).toBe(tools.length);
    expect(stored!.enabledToolCount).toBe(tools.length - 1);
  });

  it("unassigns tools that disappear or whose server is deleted", async () => {
    const { userId, server, services } = await setup();
    await refreshMcpServer(services, server);
    const agent = await createAgent(handle.db, {
      ownerId: userId,
      slug: "mcp-agent",
      name: "MCP agent",
      description: "Uses MCP",
      tools: ["files.read", "notes.echo", "notes.write_note"],
    });

    const hidden = (await updateMcpServerForUser(handle.db, userId, server.id, {
      env: secrets.applyUpdate(server.env, { MCP_TEST_HIDE: "write_note" }),
    }))!;
    const result = await refreshMcpServer(services, hidden);
    expect(result).toMatchObject({ ok: true, removed: 1 });
    expect((await getAgentForUser(handle.db, userId, agent.id))!.tools).toEqual(["files.read", "notes.echo"]);

    expect(await deleteMcpServerForUser(handle.db, userId, server.id)).toBe(true);
    expect((await getAgentForUser(handle.db, userId, agent.id))!.tools).toEqual(["files.read"]);
  });

  it("records connection failures on the server without throwing", async () => {
    const { userId, server, services } = await setup();
    const broken = (await updateMcpServerForUser(handle.db, userId, server.id, { command: "aiw-no-such-command-xyz", args: [] }))!;
    const result = await refreshMcpServer(services, broken);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(await getMcpServerForUser(handle.db, userId, server.id)).toMatchObject({ status: "error", lastError: result.error });
  });

  it("exposes MCP tools as tool definitions that run on the server", async () => {
    const { userId, server, services } = await setup();
    await refreshMcpServer(services, server);
    const source = new McpToolSource(services);
    const tools = await source.toolsForUser(userId);
    const echo = tools.find((t) => t.name === "notes.echo")!;
    expect(echo).toMatchObject({ category: "mcp", permission: "READ", timeoutMs: 60_000 });
    expect(echo.description).toContain("[MCP: Notes server]");
    expect(echo.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
    expect(tools.find((t) => t.name === "notes.delete_note")!.permission).toBe("DESTRUCTIVE");

    const { ctx, activities } = fakeContext(workspaceRoot);
    const result = await echo.execute(echo.inputSchema.parse({ text: "hi" }), ctx);
    expect(result).toMatchObject({ content: "echo: hi", summary: "Notes server · echo: echo: hi" });
    expect(activities.map((a) => a.type)).toEqual(["MCP_TOOL_STARTED", "MCP_TOOL_FINISHED"]);
    expect(activities[1]).toMatchObject({ isError: false, tool: "echo", serverName: "Notes server" });

    // Secrets are decrypted for the connection, and stdio servers start in the owner's workspace.
    const env = tools.find((t) => t.name === "notes.env")!;
    const envResult = JSON.parse((await env.execute({}, fakeContext(workspaceRoot).ctx)).content!);
    expect(envResult.token).toBe("from-db");
    expect(path.resolve(envResult.cwd)).toBe(path.resolve(Workspace.forUser(workspaceRoot, userId).root));

    const fail = tools.find((t) => t.name === "notes.fail")!;
    const failing = fakeContext(workspaceRoot);
    await expect(fail.execute({}, failing.ctx)).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("something went wrong") });
    expect(failing.activities.at(-1)).toMatchObject({ type: "MCP_TOOL_FINISHED", isError: true });

    await updateMcpServerForUser(handle.db, userId, server.id, { enabled: false });
    const disabled = await source.toolsForUser(userId);
    expect(disabled.find((t) => t.name === "notes.echo")!.availability()).toMatchObject({ available: false });
  });
});

export type { McpServer };
