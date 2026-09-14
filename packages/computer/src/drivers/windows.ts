import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolError } from "@aiw/tools";
import { WINDOWS_DRIVER_SCRIPT } from "./windows-driver-script";
import type { CapturedScreen, ComputerDriver, MouseButton, ScreenInfo } from "./types";

const COMMAND_TIMEOUT_MS = 30_000;

interface DriverReply {
  ok?: boolean;
  ready?: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Windows desktop driver: a long-lived PowerShell process (see windows-driver.ps1)
 * that uses .NET for screenshots, cursor and keyboard, and user32 for mouse buttons.
 * Screenshots are exchanged through files in a private temp directory.
 */
export class WindowsDriver implements ComputerDriver {
  readonly platform = "windows";
  private process: ChildProcess | null = null;
  private buffer = "";
  private pending: { resolve: (reply: DriverReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private stderr = "";
  private readonly tempDir = path.join(os.tmpdir(), `aiw-computer-${process.pid}`);

  static availability(): { available: boolean; reason?: string } {
    if (process.platform !== "win32") return { available: false, reason: "The Windows desktop driver only runs on Windows." };
    return { available: true };
  }

  async start(): Promise<ScreenInfo> {
    if (this.process) return this.screen();
    await mkdir(this.tempDir, { recursive: true });
    // The driver is written to a private temp file each start; it ships embedded in the bundle.
    const scriptPath = path.join(this.tempDir, "windows-driver.ps1");
    await writeFile(scriptPath, WINDOWS_DRIVER_SCRIPT, "utf8");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.process = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    child.on("exit", () => {
      this.process = null;
      const error = new ToolError("unavailable", `The desktop driver stopped.${this.stderr.trim() ? ` ${firstLine(this.stderr)}` : ""}`);
      for (const p of this.pending.splice(0)) {
        clearTimeout(p.timer);
        p.reject(error);
      }
    });
    const ready = await this.waitForReply();
    if (!ready.ready) throw new ToolError("unavailable", "The desktop driver did not start.");
    const screen = ready.screen as { width: number; height: number };
    return { width: screen.width, height: screen.height, left: 0, top: 0 };
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = null;
    try {
      child.stdin!.write(`${JSON.stringify({ op: "exit" })}\n`);
    } catch {
      // Already gone.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async screen(): Promise<ScreenInfo> {
    const r = await this.send({ op: "screen" });
    return { width: r.width as number, height: r.height as number, left: r.left as number, top: r.top as number };
  }

  async screenshot(maxWidth: number): Promise<CapturedScreen> {
    const file = path.join(this.tempDir, `${randomUUID()}.jpg`);
    const r = await this.send({ op: "screenshot", maxWidth, path: file });
    try {
      const image = await readFile(file);
      return {
        image,
        width: r.width as number,
        height: r.height as number,
        scale: r.scale as number,
        screen: { width: r.screenWidth as number, height: r.screenHeight as number, left: r.left as number, top: r.top as number },
      };
    } finally {
      await unlink(file).catch(() => {});
    }
  }

  async cursor(): Promise<{ x: number; y: number }> {
    const r = await this.send({ op: "cursor" });
    return { x: r.x as number, y: r.y as number };
  }

  async move(x: number, y: number): Promise<void> {
    await this.send({ op: "move", x, y });
  }

  async click(x: number, y: number, button: MouseButton, count: number): Promise<void> {
    await this.send({ op: "click", x, y, button, count });
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, button: MouseButton): Promise<void> {
    await this.send({ op: "drag", fromX, fromY, toX, toY, button });
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    await this.send({ op: "scroll", x, y, dx, dy });
  }

  async type(text: string): Promise<void> {
    await this.send({ op: "type", text });
  }

  async key(keys: string[]): Promise<void> {
    await this.send({ op: "key", keys });
  }

  /** Commands run one at a time in order; the driver answers each with one JSON line. */
  private send(command: Record<string, unknown>): Promise<DriverReply> {
    const run = async () => {
      if (!this.process) await this.start();
      const child = this.process;
      if (!child) throw new ToolError("unavailable", "The desktop driver is not running.");
      const reply = this.waitForReply();
      child.stdin!.write(`${JSON.stringify(command)}\n`);
      const result = await reply;
      if (!result.ok) throw new ToolError("failed", `Desktop action failed: ${result.error ?? "unknown error"}`);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private waitForReply(): Promise<DriverReply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p.timer !== timer);
        reject(new ToolError("timeout", "The desktop driver did not respond in time."));
      }, COMMAND_TIMEOUT_MS);
      this.pending.push({ resolve, reject, timer });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const pending = this.pending.shift();
      if (!pending) continue;
      clearTimeout(pending.timer);
      try {
        pending.resolve(JSON.parse(line) as DriverReply);
      } catch {
        pending.reject(new ToolError("failed", "The desktop driver returned an unreadable reply."));
      }
    }
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]!.slice(0, 200);
}
