import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { runProcess, safeProcessEnv, type ProcessResult } from "../process";
import { ToolError, type AnyToolDefinition, type PermissionLevel, type ToolContext } from "../types";
import { classifyCommand } from "./terminal";

export interface SandboxConfig {
  enabled: boolean;
  /** Image every task's container starts from. */
  image: string;
  /** "none" keeps commands off the network; "bridge" lets them install packages. */
  network: "none" | "bridge";
  /** docker --memory / --cpus values, e.g. "1g" and "1". */
  memory: string;
  cpus: string;
  /** Ceiling for one command. */
  timeoutMs: number;
  /** The server's WORKSPACE_ROOT. */
  workspaceRoot: string;
  /** The same directory as the Docker daemon sees it, when that differs (the app itself runs in a container). */
  hostWorkspaceRoot?: string | undefined;
}

/** Longer than the longest task may run (3,600 s): a container a crash left behind stops, and removes itself, on its own. */
const CONTAINER_LIFETIME_SECONDS = 3_900;
/** The first command of a task may have to pull the image. */
const START_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const WRAPPERS = new Set(["sudo", "env", "nohup", "xargs", "time", "nice", "exec", "command", "timeout"]);

export function sandboxContainerName(taskId: string): string {
  return `aiw-sbx-${taskId.replace(/[^a-zA-Z0-9_.-]/g, "")}`;
}

/**
 * A shell line is DESTRUCTIVE when any simple command in it is, by the same
 * rules as terminal.run: split on ;, &&, ||, | and command substitution, look
 * through wrappers such as sudo and env, and classify what is left. This is a
 * best-effort reading of text the model wrote — the container, which holds only
 * this workspace and no network by default, is what bounds the damage.
 */
export function classifyShellCommand(line: string): PermissionLevel {
  for (const segment of line.split(/&&|\|\||[;|\n`]|\$\(/)) {
    let words = segment.trim().split(/\s+/).filter(Boolean);
    while (words[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || WRAPPERS.has(words[0]))) words = words.slice(1);
    const [program, ...args] = words;
    if (!program) continue;
    if (classifyCommand(program.replace(/^.*\//, ""), args) === "DESTRUCTIVE") return "DESTRUCTIVE";
  }
  return "EXECUTE";
}

function formatOutput(text: string, limit = 20_000): string {
  return text.length > limit ? `${text.slice(0, limit / 2)}\n… (${text.length - limit} characters omitted) …\n${text.slice(-limit / 2)}` : text;
}

const inputSchema = z.object({
  command: z.string().trim().min(1).max(8000).describe("A shell command line, run with sh -lc, e.g. \"npm test\" or \"python3 analyse.py && ls out\""),
  cwd: z.string().trim().max(1024).default(".").describe("Working directory relative to the workspace root"),
  timeoutSeconds: z.number().int().min(1).max(1800).optional(),
});
type SandboxInput = z.infer<typeof inputSchema>;

/**
 * Runs an agent's commands in a throwaway Docker container per task: the
 * task's workspace mounted at /workspace, no network unless the operator
 * allows it, capped memory, CPU and process count, no Linux capabilities, a
 * read-only root file system and a non-root user. The container is created by
 * the task's first command, reused by the rest, and removed when the task ends.
 */
export class SandboxManager {
  private readonly started = new Set<string>();
  readonly tool: AnyToolDefinition;

  constructor(private readonly config: SandboxConfig) {
    this.tool = this.createTool();
  }

  /** Removes the task's container, if it has one. Called when the task ends. */
  async close(taskId: string): Promise<void> {
    if (!this.started.delete(taskId)) return;
    await this.docker(["rm", "-f", sandboxContainerName(taskId)], { timeoutMs: 60_000, signal: AbortSignal.timeout(60_000) }).catch(() => {});
  }

  private createTool(): AnyToolDefinition {
    const { config } = this;
    return {
      name: "sandbox.run",
      description:
        `Run a shell command in this task's own disposable Linux container (image ${config.image}). ` +
        "The workspace is mounted at /workspace, so your file tools see the same files. " +
        (config.network === "none" ? "There is no network: nothing can be downloaded or installed from the internet. " : "The network is available for installing packages. ") +
        "Anything outside /workspace is thrown away when the task ends. Commands that delete or overwrite (rm, mv, git reset --hard, …) wait for the user's approval.",
      category: "terminal",
      permission: (input: SandboxInput) => classifyShellCommand(input.command),
      timeoutMs: START_TIMEOUT_MS + config.timeoutMs + 10_000,
      inputSchema,
      availability: () =>
        config.enabled ? { available: true } : { available: false, reason: "Disabled by the server (SANDBOX_ENABLED=false)." },
      execute: async (input: SandboxInput, context: ToolContext) => {
        const cwd = await context.workspace.resolve(input.cwd, { mustExist: true });
        if (!(await stat(cwd)).isDirectory()) throw new ToolError("invalid_input", "cwd must be a directory.");
        const relCwd = context.workspace.relative(cwd);
        const workdir = path.posix.join("/workspace", relCwd === "." ? "" : relCwd.split(path.sep).join("/"));

        const name = await this.ensureContainer(context);
        context.report({ type: "TERMINAL_COMMAND_STARTED", command: input.command, cwd: relCwd });
        const timeoutMs = Math.min((input.timeoutSeconds ?? Infinity) * 1000, config.timeoutMs);
        let result: ProcessResult;
        try {
          result = await this.docker(["exec", "-w", workdir, name, "sh", "-lc", input.command], {
            timeoutMs,
            signal: context.signal,
            onOutput: context.output,
          });
        } catch (error) {
          context.report({ type: "TERMINAL_COMMAND_FINISHED", command: input.command, cwd: relCwd, exitCode: null, timedOut: false, durationMs: 0 });
          throw error;
        }
        context.report({
          type: "TERMINAL_COMMAND_FINISHED",
          command: input.command,
          cwd: relCwd,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        });
        if (result.cancelled && !result.timedOut) throw new ToolError("cancelled", "The command was stopped.");
        if (result.timedOut) {
          // A command that outlives its limit may still be running inside; start the next one clean.
          await this.close(context.taskId);
        }

        const status = result.timedOut ? "timed out" : `exit code ${result.exitCode}`;
        return {
          output: { command: input.command, cwd: relCwd, ...result },
          summary: `$ ${input.command.split("\n")[0]!.slice(0, 120)} → ${status} (${result.durationMs} ms)`,
          content: [
            `$ ${input.command}`,
            `cwd: ${workdir} · ${status} · ${result.durationMs} ms${result.truncated ? " · output truncated" : ""}`,
            result.stdout ? `--- stdout ---\n${formatOutput(result.stdout)}` : "--- stdout --- (empty)",
            result.stderr ? `--- stderr ---\n${formatOutput(result.stderr)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      },
    };
  }

  /** The task's running container, started (and its image pulled) when there is none yet. */
  private async ensureContainer(context: ToolContext): Promise<string> {
    const name = sandboxContainerName(context.taskId);
    const inspect = await this.docker(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 30_000, signal: context.signal });
    if (inspect.exitCode === 0 && inspect.stdout.trim() === "true") {
      this.started.add(context.taskId);
      return name;
    }
    // A stopped leftover under the same name would block the new one.
    if (inspect.exitCode === 0) await this.docker(["rm", "-f", name], { timeoutMs: 30_000, signal: context.signal });

    const { config } = this;
    const user = typeof process.getuid === "function" && typeof process.getgid === "function" ? `${process.getuid()}:${process.getgid()}` : "1000:1000";
    const args = [
      "run", "--detach", "--rm", "--init",
      "--name", name,
      "--label", "aiw.sandbox=1",
      "--label", `aiw.task=${context.taskId}`,
      "--network", config.network,
      "--memory", config.memory,
      "--memory-swap", config.memory,
      "--cpus", config.cpus,
      "--pids-limit", "256",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--tmpfs", "/tmp:rw,exec,nosuid,size=1g",
      // The server's own uid on Linux, so files the sandbox writes stay editable by the app.
      "--user", user,
      "--env", "HOME=/tmp",
      "--env", "CI=1",
      "--mount", `type=bind,source=${this.hostPath(context.workspace.root)},target=/workspace`,
      "--workdir", "/workspace",
      config.image,
      "sleep", String(CONTAINER_LIFETIME_SECONDS),
    ];
    const run = await this.docker(args, { timeoutMs: START_TIMEOUT_MS, signal: context.signal });
    if (run.cancelled && !run.timedOut) throw new ToolError("cancelled", "Starting the sandbox was stopped.");
    if (run.timedOut) throw new ToolError("timeout", `The sandbox did not start within ${START_TIMEOUT_MS / 60_000} minutes (pulling ${config.image}?).`);
    if (run.exitCode !== 0) {
      throw new ToolError("unavailable", `The sandbox could not start: ${(run.stderr.trim() || run.stdout.trim() || `docker exited with ${run.exitCode}`).slice(0, 500)}`);
    }
    this.started.add(context.taskId);
    return name;
  }

  /** The workspace path as the Docker daemon sees it. */
  private hostPath(workspace: string): string {
    const { workspaceRoot, hostWorkspaceRoot } = this.config;
    if (!hostWorkspaceRoot) return workspace;
    const relative = path.relative(workspaceRoot, workspace);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ToolError("unavailable", "The workspace is outside WORKSPACE_ROOT.");
    return path.join(hostWorkspaceRoot, relative);
  }

  /**
   * Runs the docker CLI with a minimal environment: no server secrets, and a
   * home of its own so it never writes into a user's workspace. DOCKER_HOST and
   * friends pass through, for a daemon that is not the local default.
   */
  private async docker(
    args: string[],
    options: { timeoutMs: number; signal: AbortSignal; onOutput?: (stream: "stdout" | "stderr", text: string) => void },
  ): Promise<ProcessResult> {
    const home = path.join(tmpdir(), "aiw-sandbox-cli");
    mkdirSync(home, { recursive: true });
    const passthrough = Object.fromEntries(
      ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
    );
    try {
      return await runProcess("docker", args, {
        cwd: home,
        env: safeProcessEnv(home, passthrough),
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        ...(options.onOutput ? { onOutput: options.onOutput } : {}),
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new ToolError("unavailable", code === "ENOENT" ? "The docker CLI is not installed on this server." : `Could not run docker (${code ?? "error"}).`);
    }
  }
}
