import { z } from "zod";
import { runProcess, safeProcessEnv } from "../process";
import { ToolError, type AnyToolDefinition, type ToolContext } from "../types";

export interface DockerConfig {
  /** Docker controls real containers on this host, so it is off unless enabled. */
  enabled: boolean;
  /** Seconds any one docker command may take. */
  timeoutMs: number;
}

const CONTAINER = z
  .string()
  .trim()
  .min(1)
  .max(200)
  // A name or id only: no flags, no shell metacharacters, nothing that could
  // turn one argument into several.
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "Give a container name or id, nothing else");

const MAX_OUTPUT = 40_000;

function clip(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} characters omitted)` : text;
}

/**
 * Built-in Docker tools (spec §15). These shell out to the real `docker` CLI on
 * this host — there is no simulation — so they are disabled by default and the
 * container argument is validated rather than interpolated.
 */
export function createDockerTools(config: DockerConfig): AnyToolDefinition[] {
  const availability = () =>
    config.enabled ? { available: true } : { available: false, reason: "Disabled by the server (DOCKER_TOOLS_ENABLED=false)." };

  async function docker(args: string[], context: ToolContext): Promise<string> {
    const command = ["docker", ...args].join(" ");
    context.report({ type: "TERMINAL_COMMAND_STARTED", command, cwd: "." });
    let result;
    try {
      result = await runProcess("docker", args, {
        cwd: context.workspace.root,
        env: safeProcessEnv(context.workspace.root),
        signal: context.signal,
        timeoutMs: config.timeoutMs,
        maxOutputBytes: 512 * 1024,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      context.report({ type: "TERMINAL_COMMAND_FINISHED", command, cwd: ".", exitCode: null, timedOut: false, durationMs: 0 });
      throw new ToolError("unavailable", code === "ENOENT" ? "The docker CLI is not installed on this server." : `Could not run docker (${code ?? "error"}).`);
    }
    context.report({
      type: "TERMINAL_COMMAND_FINISHED",
      command,
      cwd: ".",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    });
    if (result.timedOut) throw new ToolError("timeout", `docker ${args[0]} did not finish in time.`);
    if (result.exitCode !== 0) {
      // Docker's own message is the useful part; pass it through rather than a generic failure.
      throw new ToolError("failed", clip(result.stderr.trim() || result.stdout.trim() || `docker exited with code ${result.exitCode}.`));
    }
    return clip(result.stdout.trim() || "(no output)");
  }

  const psInput = z.object({
    all: z.boolean().default(false).describe("Include stopped containers"),
  });
  const logsInput = z.object({
    container: CONTAINER.describe("Container name or id"),
    tail: z.number().int().min(1).max(2000).default(200).describe("How many of the newest lines to read"),
  });
  const inspectInput = z.object({ container: CONTAINER });
  const lifecycleInput = z.object({ container: CONTAINER });

  return [
    {
      name: "docker.ps",
      description: "List Docker containers on this server with their status, image and ports.",
      category: "docker",
      permission: "READ",
      inputSchema: psInput,
      timeoutMs: config.timeoutMs + 5_000,
      availability,
      async execute(input: z.infer<typeof psInput>, context) {
        const args = ["ps", "--format", "table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"];
        if (input.all) args.splice(1, 0, "--all");
        const output = await docker(args, context);
        return { output: { text: output }, summary: `Listed containers${input.all ? " (including stopped)" : ""}`, content: output };
      },
    },
    {
      name: "docker.logs",
      description: "Read the most recent log lines from a container (spec §15: Logs).",
      category: "docker",
      permission: "READ",
      inputSchema: logsInput,
      timeoutMs: config.timeoutMs + 5_000,
      availability,
      async execute(input: z.infer<typeof logsInput>, context) {
        const output = await docker(["logs", "--tail", String(input.tail), input.container], context);
        return { output: { text: output }, summary: `Read ${input.tail} log line(s) from ${input.container}`, content: output };
      },
    },
    {
      name: "docker.stats",
      description: "One-shot CPU, memory, network and disk usage for running containers.",
      category: "docker",
      permission: "READ",
      inputSchema: z.object({}),
      timeoutMs: config.timeoutMs + 5_000,
      availability,
      async execute(_input: Record<string, never>, context) {
        const output = await docker(["stats", "--no-stream", "--format", "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}"], context);
        return { output: { text: output }, summary: "Read container resource usage", content: output };
      },
    },
    {
      name: "docker.inspect",
      description: "Full JSON configuration and state of one container.",
      category: "docker",
      permission: "READ",
      inputSchema: inspectInput,
      timeoutMs: config.timeoutMs + 5_000,
      availability,
      async execute(input: z.infer<typeof inspectInput>, context) {
        const output = await docker(["inspect", input.container], context);
        return { output: { text: output }, summary: `Inspected ${input.container}`, content: output };
      },
    },
    {
      name: "docker.restart",
      description: "Restart a container. It stops and starts again, so anything it was serving is briefly interrupted.",
      category: "docker",
      permission: "EXECUTE",
      inputSchema: lifecycleInput,
      timeoutMs: config.timeoutMs + 5_000,
      availability,
      async execute(input: z.infer<typeof lifecycleInput>, context) {
        const output = await docker(["restart", input.container], context);
        return { output: { text: output }, summary: `Restarted ${input.container}`, content: `Restarted ${input.container}.` };
      },
    },
    {
      name: "docker.stop",
      description: "Stop a running container. DESTRUCTIVE: whatever it serves goes down until something starts it again.",
      category: "docker",
      permission: "DESTRUCTIVE",
      inputSchema: lifecycleInput,
      timeoutMs: config.timeoutMs + 5_000,
      availability,
      async execute(input: z.infer<typeof lifecycleInput>, context) {
        const output = await docker(["stop", input.container], context);
        return { output: { text: output }, summary: `Stopped ${input.container}`, content: `Stopped ${input.container}.` };
      },
    },
    {
      name: "docker.remove",
      description: "Remove a container permanently. DESTRUCTIVE: requires human approval, and cannot be undone.",
      category: "docker",
      permission: "DESTRUCTIVE",
      inputSchema: lifecycleInput,
      timeoutMs: config.timeoutMs + 5_000,
      availability,
      async execute(input: z.infer<typeof lifecycleInput>, context) {
        const output = await docker(["rm", input.container], context);
        return { output: { text: output }, summary: `Removed ${input.container}`, content: `Removed container ${input.container}.` };
      },
    },
  ];
}
