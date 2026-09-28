import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyShellCommand, SandboxManager, sandboxContainerName } from "../src";
import { context, tempWorkspace } from "./helpers";

describe("classifyShellCommand", () => {
  it.each([
    ["npm test", "EXECUTE"],
    ["python3 analyse.py > out.txt && ls out", "EXECUTE"],
    ["cat log.txt | grep error | wc -l", "EXECUTE"],
    ["rm -rf build", "DESTRUCTIVE"],
    ["npm run build && rm -rf dist", "DESTRUCTIVE"],
    ["ls; /bin/rm notes.md", "DESTRUCTIVE"],
    ["sudo rm x", "DESTRUCTIVE"],
    ["FOO=1 env rm x", "DESTRUCTIVE"],
    ["git status && git reset --hard HEAD~1", "DESTRUCTIVE"],
    ["find . -name '*.log' -delete", "DESTRUCTIVE"],
    ["echo $(rm x)", "DESTRUCTIVE"],
    ["mv a.txt b.txt", "DESTRUCTIVE"],
  ] as const)("classifies %j as %s", (command, level) => {
    expect(classifyShellCommand(command)).toBe(level);
  });
});

const IMAGE = "node:22-bookworm";
/** Runs only where a Docker daemon is reachable and the image is present, as on the dev machine. */
const dockerReady = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 20_000 }).status === 0;

describe.skipIf(!dockerReady)("sandbox.run in a real container", () => {
  let ws: Awaited<ReturnType<typeof tempWorkspace>>;
  let sandbox: SandboxManager;
  const taskId = `test-${Date.now()}`;
  const run = async (command: string) => {
    const c = context(ws.workspace);
    c.ctx.taskId = taskId;
    const input = sandbox.tool.inputSchema.parse({ command });
    return { result: await sandbox.tool.execute(input, c.ctx), ...c };
  };
  const exists = (name: string) => spawnSync("docker", ["inspect", name], { stdio: "ignore" }).status === 0;

  beforeAll(async () => {
    ws = await tempWorkspace();
    sandbox = new SandboxManager({ enabled: true, image: IMAGE, network: "none", memory: "512m", cpus: "1", timeoutMs: 60_000, workspaceRoot: ws.base });
  });
  afterAll(async () => {
    await sandbox.close(taskId);
    await ws.cleanup();
  });

  it("writes into the workspace, as a non-root user, and streams output", { timeout: 180_000 }, async () => {
    const { result, output, activities } = await run("echo hello from the sandbox > note.txt && cat note.txt && id -u");
    const out = result.output as { exitCode: number; stdout: string };
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("hello from the sandbox");
    expect(out.stdout.trim().split("\n").at(-1)).not.toBe("0");
    expect(await readFile(path.join(ws.workspace.root, "note.txt"), "utf8")).toBe("hello from the sandbox\n");
    expect(output.map((o) => o.text).join("")).toContain("hello from the sandbox");
    expect(activities.map((a) => a.type)).toEqual(["TERMINAL_COMMAND_STARTED", "TERMINAL_COMMAND_FINISHED"]);
  });

  it("has no network and a read-only system, and reuses one container", { timeout: 120_000 }, async () => {
    const net = await run(`node -e "fetch('http://example.com').then(() => console.log('reached'), () => console.log('no network'))"`);
    expect((net.result.output as { stdout: string }).stdout).toContain("no network");
    const ro = await run("touch /etc/owned 2>&1; echo status=$?");
    expect((ro.result.output as { stdout: string }).stdout).toMatch(/Read-only file system[\s\S]*status=1/);
    expect(exists(sandboxContainerName(taskId))).toBe(true);
  });

  it("removes the container when the task ends", { timeout: 60_000 }, async () => {
    await sandbox.close(taskId);
    expect(exists(sandboxContainerName(taskId))).toBe(false);
  });
});
