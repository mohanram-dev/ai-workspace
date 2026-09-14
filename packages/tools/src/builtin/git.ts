import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runProcess, safeProcessEnv } from "../process";
import { ToolError, type AnyToolDefinition, type ToolContext, type ToolResult } from "../types";

let gitVersion: string | null | undefined;

function detectGit(): string | null {
  if (gitVersion === undefined) {
    const result = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    gitVersion = result.status === 0 ? result.stdout.trim() : null;
  }
  return gitVersion;
}

const availability = () =>
  detectGit() ? { available: true } : { available: false, reason: "git is not installed on the server." };

/**
 * Hardened git invocation: repository hooks and fsmonitor are disabled so a
 * repository cannot make the server run arbitrary programs; no pager, no colour.
 */
const SAFE_CONFIG = [
  "-c", `core.hooksPath=${os.devNull}`,
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "color.ui=false",
  "-c", "protocol.file.allow=never",
];

const repository = z.string().trim().max(1024).default(".").describe("Repository directory relative to the workspace root");

async function runGit(args: string[], cwd: string, context: ToolContext, timeoutMs = 60_000) {
  const result = await runProcess("git", [...SAFE_CONFIG, ...args], {
    cwd,
    env: safeProcessEnv(context.workspace.root, { GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" }),
    signal: context.signal,
    timeoutMs,
    maxOutputBytes: 512 * 1024,
  }).catch((error: NodeJS.ErrnoException) => {
    throw new ToolError("unavailable", `git could not be started (${error.code ?? error.message}).`);
  });
  if (result.cancelled) throw new ToolError("cancelled", "The git command was stopped.");
  if (result.timedOut) throw new ToolError("timeout", "The git command timed out.");
  return result;
}

function gitResult(command: string, result: Awaited<ReturnType<typeof runGit>>, summary: string): ToolResult {
  if (result.exitCode !== 0) {
    throw new ToolError("failed", `git ${command} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  }
  const text = result.stdout.trim();
  return {
    output: { command: `git ${command}`, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated },
    summary,
    content: text ? text.slice(0, 40_000) : "(no output)",
  };
}

async function repoDir(input: string, context: ToolContext): Promise<string> {
  return context.workspace.resolve(input, { mustExist: true });
}

const statusTool = {
  name: "git.status",
  description: "Show the working tree status of a git repository in the workspace.",
  category: "git",
  permission: "READ",
  timeoutMs: 60_000,
  inputSchema: z.object({ repository }),
  availability,
  async execute(input, context) {
    const cwd = await repoDir(input.repository, context);
    const result = await runGit(["status", "--short", "--branch"], cwd, context);
    return gitResult("status", result, `git status in ${context.workspace.relative(cwd)}`);
  },
} satisfies AnyToolDefinition;

const diffTool = {
  name: "git.diff",
  description: "Show changes in a git repository (working tree, or staged changes).",
  category: "git",
  permission: "READ",
  timeoutMs: 60_000,
  inputSchema: z.object({
    repository,
    staged: z.boolean().default(false),
    path: z.string().trim().max(1024).optional().describe("Limit the diff to this path"),
  }),
  availability,
  async execute(input, context) {
    const cwd = await repoDir(input.repository, context);
    const args = ["diff", "--no-ext-diff", "--no-color"];
    if (input.staged) args.push("--staged");
    if (input.path) args.push("--", path.relative(cwd, await context.workspace.resolve(input.path)));
    const result = await runGit(args, cwd, context);
    return gitResult("diff", result, `git diff${input.staged ? " --staged" : ""} (${result.stdout.split("\n").length} lines)`);
  },
} satisfies AnyToolDefinition;

const logTool = {
  name: "git.log",
  description: "Show recent commits of a git repository.",
  category: "git",
  permission: "READ",
  timeoutMs: 60_000,
  inputSchema: z.object({ repository, maxCount: z.number().int().min(1).max(50).default(10) }),
  availability,
  async execute(input, context) {
    const cwd = await repoDir(input.repository, context);
    const result = await runGit(["log", `--max-count=${input.maxCount}`, "--pretty=format:%h %ad %an: %s", "--date=short"], cwd, context);
    return gitResult("log", result, `git log (${input.maxCount} commits max)`);
  },
} satisfies AnyToolDefinition;

const initTool = {
  name: "git.init",
  description: "Initialise a new git repository in a workspace directory.",
  category: "git",
  permission: "WRITE",
  timeoutMs: 60_000,
  inputSchema: z.object({ repository }),
  availability,
  async execute(input, context) {
    const cwd = await context.workspace.resolve(input.repository);
    await mkdir(cwd, { recursive: true });
    const result = await runGit(["init", "-b", "main"], cwd, context);
    return gitResult("init", result, `Initialised git repository in ${context.workspace.relative(cwd)}`);
  },
} satisfies AnyToolDefinition;

const addTool = {
  name: "git.add",
  description: "Stage files for commit.",
  category: "git",
  permission: "WRITE",
  timeoutMs: 60_000,
  inputSchema: z.object({ repository, paths: z.array(z.string().trim().min(1).max(1024)).min(1).max(100) }),
  availability,
  async execute(input, context) {
    const cwd = await repoDir(input.repository, context);
    const relative = await Promise.all(
      input.paths.map(async (p: string) => path.relative(cwd, await context.workspace.resolve(p)) || "."),
    );
    const result = await runGit(["add", "--", ...relative], cwd, context);
    return gitResult("add", result, `Staged ${relative.length} path${relative.length === 1 ? "" : "s"}`);
  },
} satisfies AnyToolDefinition;

const commitTool = {
  name: "git.commit",
  description: "Commit staged changes with a message.",
  category: "git",
  permission: "WRITE",
  timeoutMs: 60_000,
  inputSchema: z.object({ repository, message: z.string().trim().min(1).max(5000) }),
  availability,
  async execute(input, context) {
    const cwd = await repoDir(input.repository, context);
    const result = await runGit(
      ["-c", "user.name=AI Workspace Agent", "-c", "user.email=agent@ai-workspace.local", "-c", "commit.gpgsign=false", "commit", "-m", input.message],
      cwd,
      context,
    );
    return gitResult("commit", result, `Committed: ${input.message.split("\n")[0]!.slice(0, 80)}`);
  },
} satisfies AnyToolDefinition;

export function createGitTools(): AnyToolDefinition[] {
  return [statusTool, diffTool, logTool, initTool, addTool, commitTool];
}
