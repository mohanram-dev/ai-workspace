import { stat } from "node:fs/promises";
import { z } from "zod";
import { runProcess, safeProcessEnv } from "../process";
import { ToolError, type AnyToolDefinition, type PermissionLevel } from "../types";

export interface TerminalConfig {
  enabled: boolean;
  /** Program names the agent may run, e.g. ["git", "node", "ls"]. */
  allowedCommands: string[];
  defaultTimeoutMs: number;
  maxOutputBytes?: number;
}

const DESTRUCTIVE_PROGRAMS = new Set([
  "rm", "rmdir", "rd", "del", "erase", "mv", "move", "shred", "truncate", "dd", "mkfs", "fdisk", "format", "mount", "umount",
  "shutdown", "reboot", "halt", "poweroff", "kill", "killall", "pkill", "taskkill", "chmod", "chown", "chgrp",
  "userdel", "usermod", "passwd", "crontab", "systemctl", "service", "iptables", "ufw",
]);

const GIT_DESTRUCTIVE = [
  /^reset\b.*--hard/,
  /^clean\b/,
  /^push\b.*(--force|\s-f\b|--force-with-lease|--delete|\s:\S)/,
  /^branch\b.*(\s-D\b|\s-d\b|--delete)/,
  /^stash (drop|clear)\b/,
  /^rm\b/,
  /^filter-branch\b/,
  /^update-ref -d\b/,
  /^tag\b.*(\s-d\b|--delete)/,
  /^checkout\b.*(\s--\s|\s\.$)/,
  /^restore\b/,
  /^rebase\b/,
];
const DOCKER_DESTRUCTIVE = /^(rm|rmi|kill|stop|down|prune)\b|^(system|volume|image|container|network|builder) (prune|rm)\b|^compose (down|rm|kill|stop)\b/;
const PACKAGE_DESTRUCTIVE = /^(uninstall|remove|rm|un|unpublish|prune)\b|^cache clean\b/;

function normaliseProgram(program: string): string {
  return program.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

/** Classifies a command: anything that can delete, overwrite or stop things is DESTRUCTIVE. */
export function classifyCommand(program: string, args: string[]): PermissionLevel {
  const name = normaliseProgram(program);
  const joined = args.join(" ");
  if (DESTRUCTIVE_PROGRAMS.has(name)) return "DESTRUCTIVE";
  if (name === "git" && GIT_DESTRUCTIVE.some((pattern) => pattern.test(joined.replace(/^(-c \S+ )+/, "")))) return "DESTRUCTIVE";
  if (name === "docker" && DOCKER_DESTRUCTIVE.test(joined)) return "DESTRUCTIVE";
  if (["npm", "pnpm", "yarn", "pip", "pip3"].includes(name) && PACKAGE_DESTRUCTIVE.test(joined)) return "DESTRUCTIVE";
  if (name === "find" && /(^|\s)(-delete|-exec\s+rm)\b/.test(joined)) return "DESTRUCTIVE";
  if (name === "sed" && /(^|\s)-i/.test(joined)) return "DESTRUCTIVE";
  return "EXECUTE";
}

const inputSchema = z.object({
  program: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._+-]+$/, "Program must be a plain command name without paths or spaces")
    .describe("Executable name only, e.g. git, node, ls"),
  args: z.array(z.string().max(4000)).max(64).default([]).describe("Arguments, one per item. No shell syntax is interpreted."),
  cwd: z.string().trim().max(1024).default(".").describe("Working directory relative to the workspace root"),
  timeoutSeconds: z.number().int().min(1).max(600).optional(),
});

function formatOutput(text: string, limit = 20_000): string {
  return text.length > limit ? `${text.slice(0, limit / 2)}\n… (${text.length - limit} characters omitted) …\n${text.slice(-limit / 2)}` : text;
}

export function createTerminalTool(config: TerminalConfig): AnyToolDefinition {
  const allowed = new Set(config.allowedCommands.map(normaliseProgram));
  return {
    name: "terminal.run",
    description:
      "Run a program in the workspace without a shell. Pass the program name and its arguments separately. " +
      `Allowed programs: ${[...allowed].join(", ") || "none"}. Destructive commands are blocked.`,
    category: "terminal",
    permission: (input: z.infer<typeof inputSchema>) => classifyCommand(input.program, input.args),
    timeoutMs: 600_000 + 5_000,
    inputSchema,
    availability() {
      if (!config.enabled) return { available: false, reason: "Disabled by the server (TERMINAL_ENABLED=false)." };
      if (allowed.size === 0) return { available: false, reason: "No commands are allowed (TERMINAL_ALLOWED_COMMANDS is empty)." };
      return { available: true };
    },
    async execute(input: z.infer<typeof inputSchema>, context) {
      const program = normaliseProgram(input.program);
      if (!allowed.has(program)) {
        throw new ToolError("permission_denied", `"${input.program}" is not in the allowed command list: ${[...allowed].join(", ")}.`);
      }
      const cwd = await context.workspace.resolve(input.cwd, { mustExist: true });
      if (!(await stat(cwd)).isDirectory()) throw new ToolError("invalid_input", "cwd must be a directory.");
      const command = [input.program, ...input.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ");
      const relCwd = context.workspace.relative(cwd);
      context.report({ type: "TERMINAL_COMMAND_STARTED", command, cwd: relCwd });

      let result;
      try {
        result = await runProcess(input.program, input.args, {
          cwd,
          env: safeProcessEnv(context.workspace.root),
          signal: context.signal,
          // The configured timeout is also the ceiling; the model may only ask for less.
          timeoutMs: Math.min((input.timeoutSeconds ?? Infinity) * 1000, config.defaultTimeoutMs),
          maxOutputBytes: config.maxOutputBytes ?? 512 * 1024,
          onOutput: context.output,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message =
          code === "ENOENT"
            ? `"${input.program}" was not found on the server.`
            : code === "EINVAL" && process.platform === "win32"
              ? `"${input.program}" cannot be started without a shell on Windows (.cmd/.bat programs are not supported).`
              : `Could not start "${input.program}" (${code ?? "error"}).`;
        context.report({ type: "TERMINAL_COMMAND_FINISHED", command, cwd: relCwd, exitCode: null, timedOut: false, durationMs: 0 });
        throw new ToolError("unavailable", message);
      }

      context.report({
        type: "TERMINAL_COMMAND_FINISHED",
        command,
        cwd: relCwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      if (result.cancelled && !result.timedOut) throw new ToolError("cancelled", "The command was stopped.");

      const status = result.timedOut ? "timed out" : `exit code ${result.exitCode}`;
      return {
        output: { command, cwd: relCwd, ...result },
        summary: `$ ${command} → ${status} (${result.durationMs} ms)`,
        content: [
          `$ ${command}`,
          `cwd: ${relCwd} · ${status} · ${result.durationMs} ms${result.truncated ? " · output truncated" : ""}`,
          result.stdout ? `--- stdout ---\n${formatOutput(result.stdout)}` : "--- stdout --- (empty)",
          result.stderr ? `--- stderr ---\n${formatOutput(result.stderr)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  };
}
