import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { extractReadableText, ToolError, type ToolAvailability } from "@aiw/tools";
import { startEgressProxy, type EgressProxy } from "./proxy";
import { COLLECT_ELEMENTS_SCRIPT, ELEMENT_ATTRIBUTE, type CollectedElements, type PageSnapshot, type SnapshotElement } from "./snapshot";

export interface BrowserFrame {
  taskId: string;
  seq: number;
  url: string;
  title: string;
  width: number;
  height: number;
  capturedAt: string;
}

export interface BrowserManagerOptions {
  enabled: boolean;
  /** Path to a Chromium-based browser. Defaults to Playwright's Chromium, or `channel`. */
  executablePath?: string | undefined;
  /** "chrome" or "msedge" to use an installed browser. */
  channel?: string | undefined;
  headless?: boolean;
  maxSessions?: number;
  allowPrivateNetwork?: boolean;
  viewport?: { width: number; height: number };
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  /** Close sessions without activity for this long. */
  idleTimeoutMs?: number;
  /** Live preview frames (metadata only; fetch the image with `latestFrame`). */
  onFrame?: (frame: BrowserFrame) => void;
}

const FRAME_INTERVAL_MS = 250;
/** Keep the final frame of a closed session for the UI. */
const FRAME_RETENTION_MS = 10 * 60_000;
const MAX_ELEMENTS = 150;

/**
 * One headless Chromium process shared by all tasks; each task gets an
 * isolated context (cookies, storage, cache) that is closed with the task.
 * All traffic goes through the egress proxy.
 */
export class BrowserManager {
  private browser: Promise<Browser> | null = null;
  private proxy: EgressProxy | null = null;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly opening = new Map<string, Promise<BrowserSession>>();
  private readonly frames = new Map<string, { frame: BrowserFrame; image: Buffer; expiresAt: number | null }>();
  readonly viewport: { width: number; height: number };
  readonly navigationTimeoutMs: number;
  readonly actionTimeoutMs: number;

  constructor(private readonly options: BrowserManagerOptions) {
    this.viewport = options.viewport ?? { width: 1280, height: 800 };
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
    this.actionTimeoutMs = options.actionTimeoutMs ?? 10_000;
  }

  availability(): ToolAvailability {
    if (!this.options.enabled) return { available: false, reason: "The browser is disabled on this server (BROWSER_ENABLED=false)." };
    if (this.options.executablePath && !existsSync(this.options.executablePath)) {
      return { available: false, reason: `No browser found at BROWSER_EXECUTABLE_PATH (${this.options.executablePath}).` };
    }
    if (!this.options.executablePath && !this.options.channel && !existsSync(chromium.executablePath())) {
      return { available: false, reason: "Chromium is not installed. Run `pnpm exec playwright-core install chromium` or set BROWSER_CHANNEL / BROWSER_EXECUTABLE_PATH." };
    }
    return { available: true };
  }

  get(taskId: string): BrowserSession | undefined {
    return this.sessions.get(taskId);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Returns the task's session, creating it if needed. */
  async open(taskId: string): Promise<{ session: BrowserSession; created: boolean }> {
    const existing = this.sessions.get(taskId);
    if (existing && !existing.closed) return { session: existing, created: false };
    const pending = this.opening.get(taskId);
    if (pending) return { session: await pending, created: false };

    const availability = this.availability();
    if (!availability.available) throw new ToolError("unavailable", availability.reason ?? "The browser is unavailable.");
    const max = this.options.maxSessions ?? 3;
    if (this.sessions.size + this.opening.size >= max) {
      throw new ToolError("unavailable", `All ${max} browser sessions are in use by other tasks. Try again when one finishes.`);
    }

    const promise = (async () => {
      const browser = await this.launch();
      const context = await browser.newContext({
        viewport: this.viewport,
        acceptDownloads: false,
        serviceWorkers: "block",
        locale: "en-US",
      });
      context.setDefaultNavigationTimeout(this.navigationTimeoutMs);
      context.setDefaultTimeout(this.actionTimeoutMs);
      const session = new BrowserSession(this, taskId, context);
      await session.start();
      this.sessions.set(taskId, session);
      return session;
    })();
    this.opening.set(taskId, promise);
    try {
      return { session: await promise, created: true };
    } catch (error) {
      throw toBrowserError(error);
    } finally {
      this.opening.delete(taskId);
    }
  }

  async close(taskId: string): Promise<boolean> {
    const session = this.sessions.get(taskId);
    if (!session) return false;
    this.sessions.delete(taskId);
    const frame = this.frames.get(taskId);
    if (frame) frame.expiresAt = Date.now() + FRAME_RETENTION_MS;
    await session.dispose();
    return true;
  }

  latestFrame(taskId: string): { frame: BrowserFrame; image: Buffer } | null {
    const entry = this.frames.get(taskId);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.frames.delete(taskId);
      return null;
    }
    return entry;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((taskId) => this.close(taskId)));
  }

  async shutdown(): Promise<void> {
    await this.closeAll();
    const browser = await this.browser?.catch(() => null);
    this.browser = null;
    await browser?.close().catch(() => {});
    await this.proxy?.close();
    this.proxy = null;
  }

  /** @internal */
  publishFrame(taskId: string, image: Buffer, frame: Omit<BrowserFrame, "taskId" | "seq" | "capturedAt">): void {
    const previous = this.frames.get(taskId);
    const full: BrowserFrame = { ...frame, taskId, seq: (previous?.frame.seq ?? 0) + 1, capturedAt: new Date().toISOString() };
    this.frames.set(taskId, { frame: full, image, expiresAt: this.sessions.has(taskId) ? null : Date.now() + FRAME_RETENTION_MS });
    this.sweepFrames();
    this.options.onFrame?.(full);
  }

  /** @internal */
  scheduleIdleClose(taskId: string): NodeJS.Timeout {
    const timer = setTimeout(() => void this.close(taskId), this.options.idleTimeoutMs ?? 10 * 60_000);
    timer.unref();
    return timer;
  }

  private sweepFrames(): void {
    const now = Date.now();
    for (const [taskId, entry] of this.frames) if (entry.expiresAt !== null && entry.expiresAt < now) this.frames.delete(taskId);
  }

  private launch(): Promise<Browser> {
    if (!this.browser) {
      this.browser = (async () => {
        this.proxy ??= await startEgressProxy({ allowPrivateNetwork: this.options.allowPrivateNetwork ?? false });
        const browser = await chromium.launch({
          headless: this.options.headless ?? true,
          ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
          ...(this.options.channel && !this.options.executablePath ? { channel: this.options.channel } : {}),
          args: [
            `--proxy-server=${this.proxy.url}`,
            // Chromium skips proxies for loopback by default; route it through the guard too.
            "--proxy-bypass-list=<-loopback>",
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--disable-background-networking",
            "--no-first-run",
          ],
        });
        browser.on("disconnected", () => {
          this.browser = null;
          for (const taskId of [...this.sessions.keys()]) void this.close(taskId);
        });
        return browser;
      })();
      this.browser.catch(() => {
        this.browser = null;
      });
    }
    return this.browser;
  }
}

/** A task's isolated browser context, following the most recently opened tab. */
export class BrowserSession {
  page!: Page;
  closed = false;
  /** Elements from the latest snapshot, by index. */
  elements = new Map<number, SnapshotElement>();
  private cdp: CDPSession | null = null;
  private title = "";
  private lastFrameAt = 0;
  private pendingFrame: { data: string; width: number; height: number } | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  readonly dialogs: string[] = [];

  constructor(
    private readonly manager: BrowserManager,
    readonly taskId: string,
    readonly context: BrowserContext,
  ) {}

  async start(): Promise<void> {
    this.context.on("page", (page) => void this.attach(page));
    await this.attach(await this.context.newPage());
    this.touch();
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = this.manager.scheduleIdleClose(this.taskId);
  }

  private async attach(page: Page): Promise<void> {
    if (this.closed) return;
    this.page = page;
    page.on("dialog", (dialog) => {
      this.dialogs.push(`${dialog.type()}: ${dialog.message().slice(0, 200)}`);
      void dialog.dismiss().catch(() => {});
    });
    page.on("filechooser", () => {
      this.dialogs.push("file chooser opened (file uploads are not available)");
    });
    page.on("domcontentloaded", () => void page.title().then((t) => (this.title = t)).catch(() => {}));
    page.on("close", () => {
      const pages = this.context.pages().filter((p) => !p.isClosed());
      if (!this.closed && page === this.page && pages.length > 0) void this.attach(pages[pages.length - 1]!);
    });
    await this.startScreencast(page);
  }

  private async startScreencast(page: Page): Promise<void> {
    try {
      await this.cdp?.detach().catch(() => {});
      const cdp = await this.context.newCDPSession(page);
      this.cdp = cdp;
      cdp.on("Page.screencastFrame", (event: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
        void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
        if (page !== this.page || this.closed) return;
        this.pendingFrame = { data: event.data, width: Math.round(event.metadata.deviceWidth), height: Math.round(event.metadata.deviceHeight) };
        const wait = Math.max(0, FRAME_INTERVAL_MS - (Date.now() - this.lastFrameAt));
        if (!this.frameTimer) this.frameTimer = setTimeout(() => this.flushFrame(page), wait);
      });
      const { width, height } = this.manager.viewport;
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
    } catch {
      // Live preview is best effort; screenshots after each action still work.
      this.cdp = null;
    }
  }

  private flushFrame(page: Page): void {
    this.frameTimer = null;
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    if (!frame || this.closed) return;
    this.lastFrameAt = Date.now();
    this.manager.publishFrame(this.taskId, Buffer.from(frame.data, "base64"), { url: page.url(), title: this.title, width: frame.width, height: frame.height });
  }

  async goto(url: string): Promise<void> {
    this.touch();
    const response = await this.page.goto(url, { waitUntil: "domcontentloaded" });
    if (response?.status() === 403 && (await response.text().catch(() => "")).includes("Blocked by AI Workspace")) {
      throw new ToolError("permission_denied", "Requests to local or private network addresses are blocked.");
    }
    await this.settle();
  }

  /** Waits briefly for navigation and network activity triggered by an action. */
  async settle(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
    this.title = await this.page.title().catch(() => this.title);
  }

  async snapshot(): Promise<PageSnapshot> {
    this.touch();
    const collected = (await this.page.evaluate(`(${COLLECT_ELEMENTS_SCRIPT})(${JSON.stringify({ attribute: ELEMENT_ATTRIBUTE, max: MAX_ELEMENTS })})`)) as CollectedElements;
    const html = await this.page.content();
    const url = this.page.url();
    const extracted = extractReadableText(html, url, 0);
    this.title = await this.page.title().catch(() => this.title);
    this.elements = new Map(collected.elements.map((e) => [e.index, e]));
    return {
      url,
      title: this.title,
      elements: collected.elements,
      text: extracted.text,
      scrollY: collected.scrollY,
      scrollHeight: collected.scrollHeight,
      viewportHeight: collected.viewportHeight,
      truncatedElements: collected.truncated,
    };
  }

  element(index: number) {
    if (!this.elements.has(index)) {
      throw new ToolError("not_found", `Element [${index}] is not in the latest snapshot. Use browser.snapshot to get current element numbers.`);
    }
    return this.page.locator(`[${ELEMENT_ATTRIBUTE}="${index}"]`).first();
  }

  async screenshot(fullPage = false): Promise<{ image: Buffer; width: number; height: number }> {
    this.touch();
    const image = await this.page.screenshot({ type: "jpeg", quality: 60, fullPage, animations: "disabled", timeout: this.manager.actionTimeoutMs });
    const size = this.page.viewportSize() ?? this.manager.viewport;
    const height = fullPage ? await this.page.evaluate("document.documentElement.scrollHeight").then(Number).catch(() => size.height) : size.height;
    return { image, width: size.width, height };
  }

  get currentTitle(): string {
    return this.title;
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.frameTimer) clearTimeout(this.frameTimer);
    await this.cdp?.detach().catch(() => {});
    await this.context.close().catch(() => {});
  }
}

export function toBrowserError(error: unknown): Error {
  if (error instanceof ToolError || (error as Error)?.name === "ToolError") return error as Error;
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|Failed to launch|spawn .* ENOENT|browserType\.launch/i.test(message)) {
    return new ToolError("unavailable", "The browser could not be started. Check that Chromium is installed or BROWSER_CHANNEL / BROWSER_EXECUTABLE_PATH is set.");
  }
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)) {
    return new ToolError("permission_denied", "The page could not be reached: the address is blocked (private network) or does not exist.");
  }
  if (/ERR_NAME_NOT_RESOLVED/.test(message)) return new ToolError("not_found", "The host name could not be resolved.");
  if (/Timeout \d+ms exceeded/i.test(message)) return new ToolError("timeout", "The browser action timed out.");
  if (/Target (page, context or browser )?(has been )?closed|Browser has been closed/i.test(message)) {
    return new ToolError("cancelled", "The browser session was closed.");
  }
  const firstLine = message.split("\n")[0]!.slice(0, 300);
  return new ToolError("failed", `The browser action failed: ${firstLine}`);
}
