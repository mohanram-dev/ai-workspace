import { z } from "zod";
import { classifyCommand } from "./terminal";
import { runProcess, safeProcessEnv } from "../process";
import { ToolError, type AnyToolDefinition } from "../types";

export interface SshHost {
  /** The name the agent uses; the real destination is never chosen by the model. */
  name: string;
  /** user@host or a Host entry from the server's ssh config. */
  destination: string;
  port?: number | undefined;
}

export interface SshConfig {
  enabled: boolean;
  /** Hosts an agent may reach. An agent can never invent a destination. */
  hosts: SshHost[];
  timeoutMs: number;
}

const MAX_OUTPUT = 40_000;

/**
 * SSH tools (spec §15). The agent picks a host **by name** from the list the
 * administrator configured; it never supplies a destination, so it cannot reach
 * a machine you did not name. Authentication is whatever the server's own SSH
 * setup provides (keys or agent) — no credentials are stored here.
 *
 * Commands are classified exactly like terminal.run, so a destructive remote
 * command needs approval, and ssh.run can never run unattended.
 */
export function createSshTools(config: SshConfig): AnyToolDefinition[] {
  const hosts = new Map(config.hosts.map((h) => [h.name.toLowerCase(), h]));
  const names = [...hosts.values()].map((h) => h.name);

  const inputSchema = z.object({
    host: z.string().trim().min(1).max(64).describe(`Configured host name. Available: ${names.join(", ") || "none"}`),
    command: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe("The command to run on that host, exactly as you would type it there"),
    timeoutSeconds: z.number().int().min(1).max(600).optional(),
  });

  return [
    {
      name: "ssh.run",
      description:
        `Run a command on a remote server over SSH. Choose a host by name; available: ${names.join(", ") || "none"}. ` +
        "Destructive commands require human approval.",
      category: "ssh",
      // Classified from the command itself, like the local terminal.
      permission: (input: z.infer<typeof inputSchema>) => {
        const [program = "", ...args] = input.command.split(/\s+/);
        return classifyCommand(program, args);
      },
      inputSchema,
      timeoutMs: 600_000 + 5_000,
      availability() {
        if (!config.enabled) return { available: false, reason: "Disabled by the server (SSH_TOOLS_ENABLED=false)." };
        if (hosts.size === 0) return { available: false, reason: "No SSH hosts are configured (SSH_HOSTS is empty)." };
        return { available: true };
      },
      async execute(input: z.infer<typeof inputSchema>, context) {
        const host = hosts.get(input.host.toLowerCase());
        if (!host) {
          throw new ToolError("not_found", `There is no configured host called "${input.host}". Available: ${names.join(", ") || "none"}.`);
        }

        const args = [
          "-o",
          "BatchMode=yes", // Never sit waiting for a password prompt.
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `ConnectTimeout=${Math.min(30, Math.round(config.timeoutMs / 1000))}`,
          ...(host.port ? ["-p", String(host.port)] : []),
          host.destination,
          input.command,
        ];
        const shown = `ssh ${host.name}: ${input.command}`;
        context.report({ type: "TERMINAL_COMMAND_STARTED", command: shown, cwd: host.destination });

        let result;
        try {
          result = await runProcess("ssh", args, {
            cwd: context.workspace.root,
            env: safeProcessEnv(context.workspace.root),
            signal: context.signal,
            timeoutMs: Math.min((input.timeoutSeconds ?? Infinity) * 1000, config.timeoutMs),
            maxOutputBytes: 512 * 1024,
            onOutput: context.output,
          });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          context.report({ type: "TERMINAL_COMMAND_FINISHED", command: shown, cwd: host.destination, exitCode: null, timedOut: false, durationMs: 0 });
          throw new ToolError("unavailable", code === "ENOENT" ? "The ssh client is not installed on this server." : `Could not start ssh (${code ?? "error"}).`);
        }

        context.report({
          type: "TERMINAL_COMMAND_FINISHED",
          command: shown,
          cwd: host.destination,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        });
        if (result.timedOut) throw new ToolError("timeout", `The command did not finish within the limit on ${host.name}.`);

        const stdout = clip(result.stdout.trim());
        const stderr = clip(result.stderr.trim());
        const content = [
          `$ ${input.command}   (on ${host.name}, exit ${result.exitCode})`,
          stdout && `stdout:\n${stdout}`,
          stderr && `stderr:\n${stderr}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          output: { host: host.name, exitCode: result.exitCode, stdout, stderr, durationMs: result.durationMs },
          summary: `${host.name}: ${input.command.slice(0, 60)} (exit ${result.exitCode})`,
          content,
        };
      },
    },
  ];
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} characters omitted)` : text;
}

/** Parses SSH_HOSTS: `name=user@host:port`, comma separated. */
export function parseSshHosts(raw: string): SshHost[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [name, destination] = entry.split("=", 2).map((s) => s?.trim());
      if (!name || !destination) return [];
      const match = /^(.*?)(?::(\d{1,5}))?$/.exec(destination);
      if (!match?.[1]) return [];
      return [{ name, destination: match[1], ...(match[2] ? { port: Number(match[2]) } : {}) }];
    });
}
