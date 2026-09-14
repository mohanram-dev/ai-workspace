import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyCommand,
  createBuiltinToolRegistry,
  createGuardedFetch,
  createSafeLookup,
  createSshTools,
  decidePermission,
  extractReadableText,
  isPrivateAddress,
  parseSshHosts,
  safeFetch,
  SearxngSearchService,
  toolParameters,
  type ToolRegistry,
  Workspace,
} from "../src";
import { context, tempWorkspace } from "./helpers";

let ws: Awaited<ReturnType<typeof tempWorkspace>>;
let registry: ToolRegistry;

beforeEach(async () => {
  ws = await tempWorkspace();
  registry = createBuiltinToolRegistry({
    terminal: { enabled: true, allowedCommands: ["node", "git"], defaultTimeoutMs: 20_000 },
    web: { allowPrivateNetwork: false, search: null },
  });
});

afterEach(async () => {
  await ws.cleanup();
});

async function run(name: string, input: unknown, workspace: Workspace = ws.workspace, signal?: AbortSignal) {
  const tool = registry.get(name)!;
  const parsed = tool.inputSchema.parse(input);
  const c = context(workspace, signal);
  const result = await tool.execute(parsed, c.ctx);
  return { result, ...c };
}

describe("Workspace", () => {
  it("rejects absolute paths, traversal and symlinks that escape", async () => {
    const { workspace } = ws;
    await expect(workspace.resolve("../outside.txt")).rejects.toMatchObject({ code: "permission_denied" });
    await expect(workspace.resolve("a/../../x")).rejects.toMatchObject({ code: "permission_denied" });
    await expect(workspace.resolve(path.resolve(ws.base, "x"))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(workspace.resolve("C:/Windows/win.ini")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(workspace.resolve("ok\0.txt")).rejects.toMatchObject({ code: "invalid_input" });
    expect(await workspace.resolve("sub/new.txt")).toBe(path.join(workspace.root, "sub", "new.txt"));

    const outside = path.join(ws.base, "secret");
    await mkdir(outside);
    await writeFile(path.join(outside, "key.txt"), "top secret");
    await symlink(outside, path.join(workspace.root, "link"), "junction");
    await expect(workspace.resolve("link/key.txt", { mustExist: true })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(workspace.resolve("link/new.txt")).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("builds per-user workspaces with sanitised ids", () => {
    const base = path.join(ws.base, "root");
    expect(Workspace.forUser(base, "../evil").root).toBe(path.join(base, "users", "___evil"));
    expect(() => new Workspace("relative/dir")).toThrow();
  });
});

describe("permissions", () => {
  it("allows READ, requires grants for other levels and sends DESTRUCTIVE to a human", () => {
    expect(decidePermission("READ", [])).toEqual({ outcome: "allowed" });
    expect(decidePermission("WRITE", ["WRITE"])).toEqual({ outcome: "allowed" });
    expect(decidePermission("NETWORK", ["WRITE"])).toMatchObject({ outcome: "denied", reason: "not_granted" });
    // DESTRUCTIVE is never granted in advance: it always asks (Phase 8).
    expect(decidePermission("DESTRUCTIVE", ["READ", "WRITE", "EXECUTE", "NETWORK", "DESTRUCTIVE"])).toMatchObject({ outcome: "needs_approval" });
    expect(decidePermission("DESTRUCTIVE", [], { toolName: "files.delete", approvedForTask: ["files.delete"] })).toEqual({ outcome: "allowed" });
  });

  it.each([
    [["ls", ["-la"]], "EXECUTE"],
    [["rm", ["-rf", "x"]], "DESTRUCTIVE"],
    [["git", ["status"]], "EXECUTE"],
    [["git", ["reset", "--hard", "HEAD~1"]], "DESTRUCTIVE"],
    [["git", ["push", "origin", "main:main"]], "EXECUTE"],
    [["git", ["push", "--force", "origin", "main"]], "DESTRUCTIVE"],
    [["git", ["push", "origin", ":old-branch"]], "DESTRUCTIVE"],
    [["docker", ["ps"]], "EXECUTE"],
    [["docker", ["system", "prune", "-af"]], "DESTRUCTIVE"],
    [["docker", ["rm", "production-api"]], "DESTRUCTIVE"],
    [["npm", ["uninstall", "react"]], "DESTRUCTIVE"],
    [["find", [".", "-name", "*.log", "-delete"]], "DESTRUCTIVE"],
    [["RM.EXE", ["x"]], "DESTRUCTIVE"],
  ] as const)("classifies %j as %s", ([program, args], level) => {
    expect(classifyCommand(program, [...args])).toBe(level);
  });
});

describe("file tools", () => {
  it("writes, reads, edits, lists and searches files, reporting activity", async () => {
    const write = await run("files.write", { path: "src/app.ts", content: "const a = 1;\nconst b = 2;\n" });
    expect(write.result.output).toMatchObject({ path: "src/app.ts", created: true });
    expect(write.activities).toEqual([{ type: "FILE_CREATED", path: "src/app.ts", bytes: 26 }]);

    const overwrite = await run("files.write", { path: "src/app.ts", content: "const a = 1;\nconst b = 2;\nconst c = 3;\n" });
    expect(overwrite.activities[0]).toMatchObject({ type: "FILE_UPDATED" });

    const read = await run("files.read", { path: "src/app.ts", startLine: 2, endLine: 3 });
    expect(read.result.output).toMatchObject({ content: "const b = 2;\nconst c = 3;", lines: 4 });
    expect(read.result.content).toContain("lines 2-3 of 4");
    expect(read.activities[0]).toMatchObject({ type: "FILE_READ", path: "src/app.ts" });

    const edit = await run("files.edit", { path: "src/app.ts", oldText: "const b = 2;", newText: "const b = 20;" });
    expect(edit.result.output).toMatchObject({ replacements: 1 });
    expect(await readFile(path.join(ws.workspace.root, "src/app.ts"), "utf8")).toContain("const b = 20;");
    await expect(run("files.edit", { path: "src/app.ts", oldText: "const", newText: "let" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(run("files.edit", { path: "src/app.ts", oldText: "missing", newText: "x" })).rejects.toMatchObject({ code: "not_found" });

    await run("files.write", { path: "node_modules/pkg/index.js", content: "const b = 99" });
    const list = await run("files.list", { path: ".", recursive: true });
    const paths = (list.result.output as { entries: { path: string }[] }).entries.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["src", "src/app.ts", "node_modules"]));
    expect(paths).not.toContain("node_modules/pkg");

    const search = await run("files.search", { query: "CONST B" });
    expect((search.result.output as { matches: unknown[] }).matches).toEqual([{ path: "src/app.ts", line: 2, text: "const b = 20;" }]);
  });

  it("refuses binary files, directories and escapes", async () => {
    await writeFile(path.join(ws.workspace.root, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await expect(run("files.read", { path: "image.bin" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run("files.read", { path: "missing.txt" })).rejects.toMatchObject({ code: "not_found" });
    await expect(run("files.write", { path: "../escape.txt", content: "x" })).rejects.toMatchObject({ code: "permission_denied" });
    expect(existsSync(path.join(ws.base, "escape.txt"))).toBe(false);
  });

  it("marks delete as destructive", () => {
    expect(registry.get("files.delete")?.permission).toBe("DESTRUCTIVE");
  });
});

describe("terminal.run", () => {
  it("runs allowed programs without a shell, streams output and reports exit codes", async () => {
    const { result, output, activities } = await run("terminal.run", {
      program: "node",
      args: ["-e", "console.log('hello'); console.error('warn'); process.exit(3)"],
    });
    expect(result.output).toMatchObject({ exitCode: 3, stdout: "hello\n", stderr: "warn\n", timedOut: false });
    expect(output.map((o) => o.stream).sort()).toEqual(["stderr", "stdout"]);
    expect(activities.map((a) => a.type)).toEqual(["TERMINAL_COMMAND_STARTED", "TERMINAL_COMMAND_FINISHED"]);
    expect(result.summary).toContain("exit code 3");
  });

  it("does not pass server secrets to child processes", async () => {
    process.env.AIW_TEST_SECRET = "super-secret";
    try {
      const { result } = await run("terminal.run", { program: "node", args: ["-e", "console.log(process.env.AIW_TEST_SECRET ?? 'absent')"] });
      expect((result.output as { stdout: string }).stdout.trim()).toBe("absent");
    } finally {
      delete process.env.AIW_TEST_SECRET;
    }
  });

  it("treats shell syntax as literal arguments", async () => {
    const { result } = await run("terminal.run", { program: "node", args: ["-e", "console.log(process.argv.slice(1).join('|'))", "a;", "&&", "$(whoami)"] });
    expect((result.output as { stdout: string }).stdout.trim()).toBe("a;|&&|$(whoami)");
  });

  it("enforces the allowlist, program names, timeouts and cancellation", async () => {
    await expect(run("terminal.run", { program: "python", args: [] })).rejects.toMatchObject({ code: "permission_denied" });
    expect(() => registry.get("terminal.run")!.inputSchema.parse({ program: "../bin/node", args: [] })).toThrow();

    const timed = await run("terminal.run", { program: "node", args: ["-e", "setTimeout(() => {}, 10000)"], timeoutSeconds: 1 });
    expect(timed.result.output).toMatchObject({ timedOut: true });

    // The configured timeout is a ceiling the model cannot raise.
    registry = createBuiltinToolRegistry({
      terminal: { enabled: true, allowedCommands: ["node"], defaultTimeoutMs: 1000 },
      web: { allowPrivateNetwork: false, search: null },
    });
    const capped = await run("terminal.run", { program: "node", args: ["-e", "setTimeout(() => {}, 10000)"], timeoutSeconds: 600 });
    expect(capped.result.output).toMatchObject({ timedOut: true });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(run("terminal.run", { program: "node", args: ["-e", "setTimeout(() => {}, 10000)"] }, ws.workspace, controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("is unavailable when disabled", () => {
    const disabled = createBuiltinToolRegistry({
      terminal: { enabled: false, allowedCommands: ["node"], defaultTimeoutMs: 1000 },
      web: { allowPrivateNetwork: false, search: null },
    });
    expect(disabled.availability("terminal.run")).toMatchObject({ available: false });
    expect(disabled.resolve(["terminal.run", "files.read"]).map((t) => t.name)).toEqual(["files.read"]);
  });
});

describe("git tools", () => {
  it("initialises, stages, commits and reports status, diff and log with hooks disabled", async () => {
    await run("git.init", {});
    // A hook that would create a marker file if hooks were executed.
    const hook = path.join(ws.workspace.root, ".git", "hooks", "pre-commit");
    await writeFile(hook, `#!/bin/sh\ntouch "${path.join(ws.workspace.root, "HOOK_RAN").replace(/\\/g, "/")}"\n`, { mode: 0o755 });

    await run("files.write", { path: "README.md", content: "# Demo\n" });
    const status = await run("git.status", {});
    expect(status.result.content).toContain("README.md");

    await run("git.add", { paths: ["README.md"] });
    const commit = await run("git.commit", { message: "Initial commit" });
    expect(commit.result.summary).toBe("Committed: Initial commit");
    expect(existsSync(path.join(ws.workspace.root, "HOOK_RAN"))).toBe(false);

    await run("files.write", { path: "README.md", content: "# Demo\nMore\n" });
    const diff = await run("git.diff", {});
    expect(diff.result.content).toContain("+More");
    const log = await run("git.log", { maxCount: 5 });
    expect(log.result.content).toContain("AI Workspace Agent: Initial commit");

    await expect(run("git.add", { paths: ["../outside"] })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(run("git.log", { repository: "not-here" })).rejects.toMatchObject({ code: "not_found" });
  }, 30_000);
});

describe("network safety", () => {
  it("recognises private and reserved addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(address), address).toBe(false);
  });

  it("blocks private targets by URL and at DNS resolution", async () => {
    const signal = new AbortController().signal;
    const options = { signal, timeoutMs: 5000, maxBytes: 1000 };
    await expect(safeFetch("http://127.0.0.1:1/", options)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(safeFetch("http://localhost/", options)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(safeFetch("http://[::1]/", options)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(safeFetch("file:///etc/passwd", options)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(safeFetch("http://user:pass@example.com/", options)).rejects.toMatchObject({ code: "invalid_input" });

    const lookup = createSafeLookup(false);
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup("localhost", {}, (e) => resolve(e)));
    expect(error?.code).toBe("EBLOCKED");
  });

  describe("with a local server (private network explicitly allowed)", () => {
    let server: http.Server;
    let base: string;
    beforeEach(async () => {
      server = http.createServer((req, res) => {
        if (req.url === "/redirect") return res.writeHead(302, { Location: "/page" }).end();
        if (req.url === "/loop") return res.writeHead(302, { Location: "/loop" }).end();
        if (req.url === "/big") return res.writeHead(200, { "Content-Type": "text/plain" }).end("x".repeat(5000));
        if (req.url === "/echo") {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            res.writeHead(201, { "Content-Type": "application/json", "Set-Cookie": ["a=1", "b=2"] });
            res.write(JSON.stringify({ method: req.method, auth: req.headers.authorization ?? null }));
            setTimeout(() => res.end(JSON.stringify({ body: Buffer.concat(chunks).toString() })), 50);
          });
          return;
        }
        const html = "<html><head><title>Demo &amp; Test</title><style>.x{}</style></head><body><nav>menu</nav><h1>Hello</h1><p>World <a href=\"/next\">Next page</a></p><script>alert(1)</script></body></html>";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "gzip" }).end(zlib.gzipSync(html));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("follows redirects, decompresses, limits size and stops redirect loops", async () => {
      const options = { signal: new AbortController().signal, timeoutMs: 5000, maxBytes: 1000, allowPrivateNetwork: true };
      const page = await safeFetch(`${base}/redirect`, options);
      expect(page).toMatchObject({ url: `${base}/page`, status: 200 });
      expect(page.body).toContain("<h1>Hello</h1>");
      const big = await safeFetch(`${base}/big`, options);
      expect(big).toMatchObject({ truncated: true, bytes: 1000 });
      await expect(safeFetch(`${base}/loop`, options)).rejects.toMatchObject({ code: "failed" });
    });

    it("guarded fetch streams responses, sends bodies and headers, and does not follow redirects", async () => {
      const guarded = createGuardedFetch({ allowPrivateNetwork: true });
      const response = await guarded(`${base}/echo`, { method: "POST", headers: { Authorization: "Bearer t" }, body: "payload" });
      expect(response.status).toBe(201);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.text()).toBe('{"method":"POST","auth":"Bearer t"}{"body":"payload"}');
      const redirect = await guarded(`${base}/redirect`);
      expect(redirect.status).toBe(302);
      await redirect.body?.cancel();

      const blocked = createGuardedFetch({ allowPrivateNetwork: false });
      await expect(blocked(`${base}/echo`)).rejects.toMatchObject({ code: "permission_denied" });
      await expect(blocked("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ code: "permission_denied" });
      await expect(blocked("file:///etc/passwd")).rejects.toThrow();
    });

    it("web.fetch returns readable text and reports PAGE_READ", async () => {
      const local = createBuiltinToolRegistry({
        terminal: { enabled: false, allowedCommands: [], defaultTimeoutMs: 1000 },
        web: { allowPrivateNetwork: true, search: null },
      });
      const tool = local.get("web.fetch")!;
      const c = context(ws.workspace);
      const result = await tool.execute(tool.inputSchema.parse({ url: `${base}/page` }), c.ctx);
      expect(result.output).toMatchObject({ title: "Demo & Test", status: 200 });
      expect((result.output as { text: string }).text).toBe("# Hello\nWorld Next page");
      expect((result.output as { links: unknown[] }).links).toEqual([{ text: "Next page", url: `${base}/next` }]);
      expect(c.activities[0]).toMatchObject({ type: "PAGE_READ", status: 200 });
    });
  });
});

describe("html extraction", () => {
  it("drops scripts and chrome, keeps structure and decodes entities", () => {
    const page = extractReadableText(
      "<title>T</title><body><footer>f</footer><h2>Intro</h2><ul><li>One &lt;1&gt;</li><li>Two&#39;s</li></ul><a href='javascript:alert(1)'>bad</a></body>",
      "https://example.com",
    );
    expect(page.text).toBe("## Intro\n- One <1>\n- Two's\nbad");
    expect(page.links).toEqual([]);
  });
});

describe("web.search and registry", () => {
  it("uses the configured search service and reports unavailability otherwise", async () => {
    const fakeFetch = (async (url: URL) => {
      expect(url.searchParams.get("format")).toBe("json");
      return new Response(JSON.stringify({ results: [{ title: "Node.js", url: "https://nodejs.org", content: "Run JS" }, { title: "bad" }], answers: ["Node 24"] }));
    }) as unknown as typeof fetch;
    const searchRegistry = createBuiltinToolRegistry({
      terminal: { enabled: false, allowedCommands: [], defaultTimeoutMs: 1000 },
      web: { allowPrivateNetwork: false, search: new SearxngSearchService("http://searx.local", fakeFetch) },
    });
    const tool = searchRegistry.get("web.search")!;
    const result = await tool.execute(tool.inputSchema.parse({ query: "node" }), context(ws.workspace).ctx);
    expect(result.output).toMatchObject({ answer: "Node 24", results: [{ title: "Node.js", url: "https://nodejs.org", snippet: "Run JS" }] });
    expect(registry.availability("web.search")).toMatchObject({ available: false });
  });

  it("describes tools and produces clean JSON Schemas", () => {
    const info = registry.describe();
    expect(info.find((t) => t.name === "terminal.run")).toMatchObject({ permission: "DYNAMIC", category: "terminal" });
    expect(info.find((t) => t.name === "files.write")).toMatchObject({ permission: "WRITE", available: true });
    const schema = toolParameters(registry.get("files.read")!);
    expect(schema.$schema).toBeUndefined();
    expect(schema).toMatchObject({ type: "object", required: ["path"], properties: { path: { type: "string" } } });
  });
});

describe("infrastructure tools (spec §15)", () => {
  it("registers docker, ssh and github tools", () => {
    const names = registry.list().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "docker.ps",
        "docker.logs",
        "docker.stats",
        "docker.inspect",
        "docker.restart",
        "docker.stop",
        "docker.remove",
        "ssh.run",
        "github.search_repositories",
        "github.list_issues",
        "github.read_issue",
      ]),
    );
  });

  it("keeps docker and ssh unavailable until the server enables them", () => {
    expect(registry.availability("docker.ps")).toMatchObject({ available: false, reason: expect.stringContaining("DOCKER_TOOLS_ENABLED") });
    expect(registry.availability("ssh.run")).toMatchObject({ available: false, reason: expect.stringContaining("SSH_TOOLS_ENABLED") });
    // GitHub only reads a public API, so it needs no switch.
    expect(registry.availability("github.search_repositories")).toEqual({ available: true });
  });

  it("classifies destructive container operations correctly", () => {
    const permissionOf = (name: string) => {
      const tool = registry.get(name)!;
      return typeof tool.permission === "function" ? "dynamic" : tool.permission;
    };
    expect(permissionOf("docker.ps")).toBe("READ");
    expect(permissionOf("docker.logs")).toBe("READ");
    expect(permissionOf("docker.restart")).toBe("EXECUTE");
    expect(permissionOf("docker.stop")).toBe("DESTRUCTIVE");
    expect(permissionOf("docker.remove")).toBe("DESTRUCTIVE");
  });

  it("refuses a container argument that is not a plain name", () => {
    const schema = registry.get("docker.logs")!.inputSchema;
    expect(schema.safeParse({ container: "api", tail: 10 }).success).toBe(true);
    for (const bad of ["--privileged", "a b", "$(whoami)", "api;rm -rf /", "-v/:/host"]) {
      expect(schema.safeParse({ container: bad }).success).toBe(false);
    }
  });

  it("derives the ssh command's permission from the command itself", () => {
    const tool = registry.get("ssh.run")!;
    const permission = tool.permission as (input: { host: string; command: string }) => string;
    expect(permission({ host: "web", command: "docker ps" })).toBe("EXECUTE");
    expect(permission({ host: "web", command: "rm -rf /var/data" })).toBe("DESTRUCTIVE");
  });

  it("parses SSH_HOSTS into named destinations and ignores rubbish", () => {
    expect(parseSshHosts("web=deploy@10.0.0.5:2222, db=postgres@db.internal")).toEqual([
      { name: "web", destination: "deploy@10.0.0.5", port: 2222 },
      { name: "db", destination: "postgres@db.internal" },
    ]);
    expect(parseSshHosts("")).toEqual([]);
    expect(parseSshHosts("nonsense,=,also=")).toEqual([]);
  });

  it("names only configured hosts, so an agent cannot invent a destination", async () => {
    const ssh = createSshTools({ enabled: true, hosts: [{ name: "web", destination: "deploy@10.0.0.5" }], timeoutMs: 5_000 })[0]!;
    expect(ssh.availability()).toEqual({ available: true });
    await expect(ssh.execute({ host: "other-server", command: "ls" }, context(ws.workspace).ctx)).rejects.toThrow(/no configured host called "other-server"/);
  });
});
