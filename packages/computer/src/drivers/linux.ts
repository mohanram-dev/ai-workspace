import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ToolError } from "@aiw/tools";
import type { CapturedScreen, ComputerDriver, MouseButton, ScreenInfo } from "./types";

const run = promisify(execFile);
const BUTTONS: Record<MouseButton, string> = { left: "1", middle: "2", right: "3" };
const KEY_NAMES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  space: "space",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  shift: "shift",
  win: "super",
  super: "super",
  meta: "super",
  cmd: "super",
};

/**
 * Linux X11 driver built on `xdotool` (input) and ImageMagick `import` (capture).
 * UNTESTED in this repository's CI: it was written against the tools' documented
 * interfaces but has not been exercised on a Linux desktop yet.
 */
export class LinuxDriver implements ComputerDriver {
  readonly platform = "linux";
  private readonly tempDir = path.join(os.tmpdir(), `aiw-computer-${process.pid}`);

  static async availability(): Promise<{ available: boolean; reason?: string }> {
    if (process.platform !== "linux") return { available: false, reason: "The Linux desktop driver only runs on Linux." };
    if (!process.env.DISPLAY) return { available: false, reason: "No X11 display (DISPLAY is not set)." };
    for (const tool of ["xdotool", "import"]) {
      try {
        await run("which", [tool]);
      } catch {
        return { available: false, reason: `${tool} is not installed (needs xdotool and ImageMagick).` };
      }
    }
    return { available: true };
  }

  async start(): Promise<ScreenInfo> {
    await mkdir(this.tempDir, { recursive: true });
    return this.screen();
  }

  async stop(): Promise<void> {}

  async screen(): Promise<ScreenInfo> {
    const { stdout } = await run("xdotool", ["getdisplaygeometry"]);
    const [width, height] = stdout.trim().split(/\s+/).map(Number);
    return { width: width ?? 0, height: height ?? 0, left: 0, top: 0 };
  }

  async screenshot(maxWidth: number): Promise<CapturedScreen> {
    const screen = await this.screen();
    const file = path.join(this.tempDir, `${randomUUID()}.jpg`);
    const scale = screen.width > maxWidth ? maxWidth / screen.width : 1;
    const args = ["-window", "root", "-quality", "75", ...(scale < 1 ? ["-resize", `${maxWidth}x`] : []), file];
    await run("import", args);
    try {
      const image = await readFile(file);
      return { image, width: Math.round(screen.width * scale), height: Math.round(screen.height * scale), scale, screen };
    } finally {
      await unlink(file).catch(() => {});
    }
  }

  async cursor(): Promise<{ x: number; y: number }> {
    const { stdout } = await run("xdotool", ["getmouselocation", "--shell"]);
    const x = Number(/^X=(\d+)/m.exec(stdout)?.[1] ?? 0);
    const y = Number(/^Y=(\d+)/m.exec(stdout)?.[1] ?? 0);
    return { x, y };
  }

  async move(x: number, y: number): Promise<void> {
    await run("xdotool", ["mousemove", String(x), String(y)]);
  }

  async click(x: number, y: number, button: MouseButton, count: number): Promise<void> {
    await run("xdotool", ["mousemove", String(x), String(y), "click", "--repeat", String(count), "--delay", "80", BUTTONS[button]]);
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, button: MouseButton): Promise<void> {
    await run("xdotool", ["mousemove", String(fromX), String(fromY), "mousedown", BUTTONS[button], "mousemove", String(toX), String(toY), "mouseup", BUTTONS[button]]);
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    await run("xdotool", ["mousemove", String(x), String(y)]);
    for (let i = 0; i < Math.abs(dy); i++) await run("xdotool", ["click", dy > 0 ? "5" : "4"]);
    for (let i = 0; i < Math.abs(dx); i++) await run("xdotool", ["click", dx > 0 ? "7" : "6"]);
  }

  async type(text: string): Promise<void> {
    await run("xdotool", ["type", "--delay", "12", "--", text]);
  }

  async key(keys: string[]): Promise<void> {
    const mapped = keys.map((k) => {
      const name = k.toLowerCase();
      if (KEY_NAMES[name]) return KEY_NAMES[name];
      if (/^f\d{1,2}$/.test(name)) return name.toUpperCase();
      if (name.length === 1) return name;
      throw new ToolError("invalid_input", `Unknown key: ${k}`);
    });
    await run("xdotool", ["key", "--", mapped.join("+")]);
  }
}
