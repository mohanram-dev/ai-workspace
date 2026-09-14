import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createGuardedFetch, isToolError, ToolError } from "@aiw/tools";
import { clip } from "./results";

export interface McpConnectionConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  url: string | null;
  /** Decrypted header values (http). */
  headers: Record<string, string>;
  /** Decrypted environment values (stdio). */
  env: Record<string, string>;
  /** Working directory for stdio servers. */
  cwd?: string;
}

export interface McpManagerOptions {
  /** stdio servers run a command on this host. */
  stdioEnabled: boolean;
  /** Allow http servers on loopback / private addresses. */
  allowPrivateNetwork: boolean;
  connectTimeoutMs?: number;
  /** Close connections unused for this long. */
  idleTimeoutMs?: number;
  clientVersion?: string;
}

export interface McpServerInfo {
  name: string | null;
  version: string | null;
}

interface Connection {
  fingerprint: string;
  ready: Promise<Client>;
  client: Client | null;
  stderr: string;
  idleTimer: NodeJS.Timeout | null;
  closed: boolean;
}

const MAX_TOOLS = 500;
const MAX_PAGES = 50;
const STDERR_TAIL = 2000;

/**
 * Keeps one MCP client per configured server, connected lazily, reused across
 * tasks, reconnected when the configuration changes and closed when idle.
 */
export class McpConnectionManager {
  private readonly connections = new Map<string, Connection>();
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(private readonly options: McpManagerOptions) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  }

  get stdioEnabled(): boolean {
    return this.options.stdioEnabled;
  }

  /** Connects (or reuses the connection) and lists every tool, following pagination. */
  async listTools(config: McpConnectionConfig, signal?: AbortSignal): Promise<{ tools: Tool[]; server: McpServerInfo }> {
    const { client } = await this.acquire(config);
    try {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: this.connectTimeoutMs,
          ...(signal ? { signal } : {}),
        });
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (!cursor || tools.length >= MAX_TOOLS) break;
      }
      const version = client.getServerVersion();
      return { tools: tools.slice(0, MAX_TOOLS), server: { name: version?.name ?? null, version: version?.version ?? null } };
    } catch (error) {
      throw this.toToolError(error, config, "list tools");
    } finally {
      this.touch(config.id);
    }
  }

  async callTool(
    config: McpConnectionConfig,
    name: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<CallToolResult> {
    const { client } = await this.acquire(config, options.signal);
    try {
      // The caller's signal enforces the tool time limit; the SDK timeout is a backstop.
      return (await client.callTool({ name, arguments: args }, { signal: options.signal, timeout: options.timeoutMs + 5000 })) as CallToolResult;
    } catch (error) {
      if (options.signal.aborted) throw error;
      throw this.toToolError(error, config, `call ${name}`);
    } finally {
      this.touch(config.id);
    }
  }

  /** Closes a server's connection (e.g. after its configuration changed or it was deleted). */
  async close(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    this.connections.delete(serverId);
    await this.dispose(connection);
  }

  async closeAll(): Promise<void> {
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(all.map((c) => this.dispose(c)));
  }

  /** Number of open connections (for diagnostics and tests). */
  get size(): number {
    return this.connections.size;
  }

  private async acquire(config: McpConnectionConfig, signal?: AbortSignal): Promise<{ client: Client }> {
    const fingerprint = fingerprintOf(config);
    let connection = this.connections.get(config.id);
    if (connection && (connection.fingerprint !== fingerprint || connection.closed)) {
      this.connections.delete(config.id);
      void this.dispose(connection);
      connection = undefined;
    }
    if (!connection) {
      connection = { fingerprint, ready: Promise.resolve(null as unknown as Client), client: null, stderr: "", idleTimer: null, closed: false };
      connection.ready = this.connect(config, connection);
      this.connections.set(config.id, connection);
    }
    const current = connection;
    try {
      const client = signal ? await abortable(current.ready, signal) : await current.ready;
      return { client };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (this.connections.get(config.id) === current) this.connections.delete(config.id);
      void this.dispose(current);
      throw this.toToolError(error, config, "connect", current.stderr);
    }
  }

  private async connect(config: McpConnectionConfig, connection: Connection): Promise<Client> {
    const client = new Client({ name: "ai-workspace", version: this.options.clientVersion ?? "0.1.0" });
    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    if (config.transport === "stdio") {
      if (!this.options.stdioEnabled) throw new ToolError("unavailable", "stdio MCP servers are disabled on this server (MCP_STDIO_ENABLED=false).");
      if (!config.command) throw new ToolError("invalid_input", "The stdio server has no command.");
      if (config.cwd) await mkdir(config.cwd, { recursive: true });
      // Only the SDK's safe default variables (PATH, HOME, ...) plus the server's own
      // configured variables; the workspace's secrets are never inherited.
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...getDefaultEnvironment(), ...config.env },
        stderr: "pipe",
        ...(config.cwd ? { cwd: config.cwd } : {}),
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        connection.stderr = (connection.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
      });
    } else {
      if (!config.url) throw new ToolError("invalid_input", "The http server has no URL.");
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        fetch: createGuardedFetch({ allowPrivateNetwork: this.options.allowPrivateNetwork }),
        requestInit: { headers: config.headers },
        reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 1000, maxReconnectionDelay: 10_000, reconnectionDelayGrowFactor: 1.5 },
      });
    }

    client.onclose = () => {
      connection.closed = true;
      if (this.connections.get(config.id) === connection) this.connections.delete(config.id);
    };
    client.onerror = () => {
      // Transport errors surface on the pending request; nothing else to do here.
    };

    await client.connect(transport, { timeout: this.connectTimeoutMs });
    connection.client = client;
    return client;
  }

  private touch(serverId: string): void {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = setTimeout(() => void this.close(serverId), this.idleTimeoutMs);
    connection.idleTimer.unref();
  }

  private async dispose(connection: Connection): Promise<void> {
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.closed = true;
    const client = connection.client ?? (await connection.ready.catch(() => null));
    await client?.close().catch(() => {});
  }

  private toToolError(error: unknown, config: McpConnectionConfig, action: string, stderr = ""): ToolError {
    const found = findToolError(error);
    if (found) return found;

    const err = error as { code?: unknown; status?: unknown; message?: unknown; name?: unknown };
    const message = typeof err?.message === "string" ? err.message : String(error);
    if (err?.code === "REQUEST_TIMEOUT") return new ToolError("timeout", `MCP server "${config.name}" did not respond in time (${action}).`);
    if (err?.code === "ENOENT") return new ToolError("unavailable", `The command "${config.command}" for MCP server "${config.name}" was not found.`);
    const status = typeof err?.status === "number" ? err.status : null;
    if (status === 401 || status === 403 || err?.name === "UnauthorizedError") {
      return new ToolError("unavailable", `MCP server "${config.name}" rejected the credentials (HTTP ${status ?? 401}). Check the configured headers.`);
    }
    const detail = stderr.trim() ? ` Server output: ${clip(stderr.trim(), 500)}` : "";
    return new ToolError("unavailable", `MCP server "${config.name}" failed to ${action}: ${clip(message, 300)}${detail}`);
  }
}

function findToolError(error: unknown): ToolError | null {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (isToolError(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function fingerprintOf(config: McpConnectionConfig): string {
  const { name: _name, ...connectionFields } = config;
  return createHash("sha256").update(JSON.stringify(connectionFields)).digest("hex");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
