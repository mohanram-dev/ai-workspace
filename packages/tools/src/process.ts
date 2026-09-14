import { spawn } from "node:child_process";

export interface RunProcessOptions {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  /** Bytes kept per stream; later output is dropped and reported as truncated. */
  maxOutputBytes?: number;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

/**
 * Runs a program without a shell (arguments are never interpreted), streaming
 * output and enforcing a timeout, cancellation and an output cap.
 */
export function runProcess(program: string, args: string[], options: RunProcessOptions): Promise<ProcessResult> {
  const maxBytes = options.maxOutputBytes ?? 1024 * 1024;
  const started = performance.now();

  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      // Record<string, string> is what spawn uses at runtime; ProcessEnv typing varies across @types/node augmentations.
      env: options.env as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const buffers = { stdout: "", stderr: "" };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      options.onOutput?.(stream, text);
      if (sizes[stream] >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - sizes[stream];
      const kept = chunk.length > room ? chunk.subarray(0, room).toString("utf8") : text;
      if (chunk.length > room) truncated = true;
      buffers[stream] += kept;
      sizes[stream] += Math.min(chunk.length, room);
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));

    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    if (options.signal.aborted) onAbort();
    options.signal.addEventListener("abort", onAbort, { once: true });

    const finish = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      finish();
      resolve({
        exitCode,
        signal,
        stdout: buffers.stdout,
        stderr: buffers.stderr,
        truncated,
        timedOut,
        cancelled,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}

const PASSTHROUGH_ENV = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"];

/**
 * Minimal environment for child processes: never inherits secrets such as API
 * keys, database URLs or auth secrets from the server process.
 */
export function safeProcessEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1", ...extra };
}
