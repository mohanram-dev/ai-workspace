import { ToolError, type ToolAvailability } from "@aiw/tools";
import { LinuxDriver } from "./drivers/linux";
import type { CapturedScreen, ComputerDriver, MouseButton, ScreenInfo } from "./drivers/types";
import { WindowsDriver } from "./drivers/windows";

export interface ComputerFrame {
  taskId: string;
  seq: number;
  width: number;
  height: number;
  capturedAt: string;
}

export interface ComputerManagerOptions {
  enabled: boolean;
  /** Longest side of screenshots sent to the model and shown live. */
  maxWidth?: number;
  /** Close a session without activity for this long. */
  idleTimeoutMs?: number;
  createDriver?: () => ComputerDriver;
  onFrame?: (frame: ComputerFrame) => void;
}

const FRAME_RETENTION_MS = 10 * 60_000;

/**
 * Single-desktop computer use: at most one task controls the machine's screen,
 * mouse and keyboard at a time, through a platform driver. There is exactly one
 * real desktop, so a second task is refused rather than queued.
 */
export class ComputerManager {
  private session: ComputerSession | null = null;
  private starting: Promise<ComputerSession> | null = null;
  private readonly frames = new Map<string, { frame: ComputerFrame; image: Buffer; expiresAt: number | null }>();
  readonly maxWidth: number;
  private readonly idleTimeoutMs: number;

  constructor(private readonly options: ComputerManagerOptions) {
    this.maxWidth = options.maxWidth ?? 1280;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  }

  availability(): ToolAvailability {
    if (!this.options.enabled) {
      return { available: false, reason: "Computer use is disabled on this server (COMPUTER_USE_ENABLED=false)." };
    }
    if (this.options.createDriver) return { available: true };
    if (process.platform === "win32") return WindowsDriver.availability();
    if (process.platform === "linux") {
      // The Linux driver needs a display and tools; report a generic reason without blocking here.
      return process.env.DISPLAY ? { available: true } : { available: false, reason: "No X11 display (DISPLAY is not set)." };
    }
    return { available: false, reason: `Computer use is not supported on ${process.platform}.` };
  }

  get(taskId: string): ComputerSession | undefined {
    return this.session?.taskId === taskId && !this.session.closed ? this.session : undefined;
  }

  async open(taskId: string): Promise<{ session: ComputerSession; created: boolean }> {
    if (this.session && this.session.taskId === taskId && !this.session.closed) return { session: this.session, created: false };
    if (this.starting) await this.starting.catch(() => {});
    if (this.session && !this.session.closed && this.session.taskId !== taskId) {
      throw new ToolError("unavailable", "Another task is currently controlling the computer. Only one may do so at a time.");
    }
    const availability = this.availability();
    if (!availability.available) throw new ToolError("unavailable", availability.reason ?? "Computer use is unavailable.");

    this.starting = (async () => {
      const driver = this.options.createDriver ? this.options.createDriver() : createDefaultDriver();
      const screen = await driver.start();
      const session = new ComputerSession(this, taskId, driver, screen);
      this.session = session;
      return session;
    })();
    try {
      const session = await this.starting;
      return { session, created: true };
    } catch (error) {
      this.session = null;
      throw error instanceof ToolError ? error : new ToolError("unavailable", "The desktop could not be controlled.");
    } finally {
      this.starting = null;
    }
  }

  async close(taskId: string): Promise<boolean> {
    if (!this.session || this.session.taskId !== taskId) return false;
    const session = this.session;
    this.session = null;
    const frame = this.frames.get(taskId);
    if (frame) frame.expiresAt = Date.now() + FRAME_RETENTION_MS;
    await session.dispose();
    return true;
  }

  latestFrame(taskId: string): { frame: ComputerFrame; image: Buffer } | null {
    const entry = this.frames.get(taskId);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.frames.delete(taskId);
      return null;
    }
    return entry;
  }

  async shutdown(): Promise<void> {
    if (this.session) await this.close(this.session.taskId);
  }

  /** @internal */
  publishFrame(taskId: string, image: Buffer, size: { width: number; height: number }): void {
    const previous = this.frames.get(taskId);
    const frame: ComputerFrame = { taskId, seq: (previous?.frame.seq ?? 0) + 1, width: size.width, height: size.height, capturedAt: new Date().toISOString() };
    this.frames.set(taskId, { frame, image, expiresAt: this.session?.taskId === taskId ? null : Date.now() + FRAME_RETENTION_MS });
    this.sweep();
    this.options.onFrame?.(frame);
  }

  /** @internal */
  scheduleIdleClose(taskId: string): NodeJS.Timeout {
    const timer = setTimeout(() => void this.close(taskId), this.idleTimeoutMs);
    timer.unref();
    return timer;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [taskId, entry] of this.frames) if (entry.expiresAt !== null && entry.expiresAt < now) this.frames.delete(taskId);
  }
}

/** A task's control of the desktop. Coordinates from the model are in screenshot pixels and scaled to the screen. */
export class ComputerSession {
  closed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Screenshot pixels per screen pixel from the most recent capture. */
  private lastScale = 1;

  constructor(
    private readonly manager: ComputerManager,
    readonly taskId: string,
    private readonly driver: ComputerDriver,
    readonly screen: ScreenInfo,
  ) {
    this.touch();
  }

  get platform(): string {
    return this.driver.platform;
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = this.manager.scheduleIdleClose(this.taskId);
  }

  /** Captures the screen, publishes a live frame, and records the scale for coordinate mapping. */
  async capture(): Promise<CapturedScreen> {
    this.touch();
    const shot = await this.driver.screenshot(this.manager.maxWidth);
    this.lastScale = shot.scale || 1;
    this.manager.publishFrame(this.taskId, shot.image, { width: shot.width, height: shot.height });
    return shot;
  }

  /** Maps a point from screenshot pixels (what the model sees) to screen pixels. */
  private toScreen(x: number, y: number): { x: number; y: number } {
    const scale = this.lastScale || 1;
    return { x: this.screen.left + Math.round(x / scale), y: this.screen.top + Math.round(y / scale) };
  }

  async cursor(): Promise<{ x: number; y: number }> {
    const point = await this.driver.cursor();
    const scale = this.lastScale || 1;
    return { x: Math.round((point.x - this.screen.left) * scale), y: Math.round((point.y - this.screen.top) * scale) };
  }

  async move(x: number, y: number): Promise<void> {
    this.touch();
    const p = this.toScreen(x, y);
    await this.driver.move(p.x, p.y);
  }

  async click(x: number, y: number, button: MouseButton, count: number): Promise<void> {
    this.touch();
    const p = this.toScreen(x, y);
    await this.driver.click(p.x, p.y, button, count);
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, button: MouseButton): Promise<void> {
    this.touch();
    const from = this.toScreen(fromX, fromY);
    const to = this.toScreen(toX, toY);
    await this.driver.drag(from.x, from.y, to.x, to.y, button);
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    this.touch();
    const p = this.toScreen(x, y);
    await this.driver.scroll(p.x, p.y, dx, dy);
  }

  async type(text: string): Promise<void> {
    this.touch();
    await this.driver.type(text);
  }

  async key(keys: string[]): Promise<void> {
    this.touch();
    await this.driver.key(keys);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.driver.stop().catch(() => {});
  }
}

function createDefaultDriver(): ComputerDriver {
  if (process.platform === "win32") return new WindowsDriver();
  if (process.platform === "linux") return new LinuxDriver();
  throw new ToolError("unavailable", `Computer use is not supported on ${process.platform}.`);
}
