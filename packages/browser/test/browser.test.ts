import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { Workspace, type ToolActivity, type ToolContext } from "@aiw/tools";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BrowserManager, createBrowserTools, formatSnapshot, startEgressProxy, type BrowserFrame } from "../src";

let site: http.Server;
let base: string;

beforeAll(async () => {
  site = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/two") {
      res.setHeader("content-type", "text/html");
      return res.end(`<title>Two</title><h1>Page two</h1><p>q=${url.searchParams.get("q")} s=${url.searchParams.get("s")}</p><a href="/">Home</a>`);
    }
    if (url.pathname === "/redirect-private") return res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (url.pathname === "/dialog") return res.end("<title>Dialog</title><script>alert('hi')</script><button onclick=\"alert('x')\">Alert</button>");
    if (url.pathname === "/long") return res.end(`<title>Long</title>${"<p>line</p>".repeat(400)}<a href='/'>Bottom link</a>`);
    res.setHeader("content-type", "text/html");
    res.end(
      `<title>Demo</title><h1>Hello</h1><form action="/two"><label>Name <input name="q"></label><input type="password" name="p"><select name="s"><option>A</option><option>B</option></select><button type="submit">Go</button></form><a href="/two">Link</a><div style="display:none"><a href="/hidden">Hidden</a></div>`,
    );
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => site.close(() => r())));

function harness(manager: BrowserManager, taskId = "task-1") {
  const tools = Object.fromEntries(createBrowserTools(manager).map((t) => [t.name, t]));
  const activities: ToolActivity[] = [];
  const controller = new AbortController();
  const ctx: ToolContext = { taskId, userId: "u", workspace: new Workspace(os.tmpdir()), signal: controller.signal, report: (a) => activities.push(a), output: () => {} };
  const run = (name: string, input: unknown) => tools[name]!.execute(tools[name]!.inputSchema.parse(input), ctx);
  return { tools, activities, controller, run };
}

describe("egress proxy", () => {
  it("blocks private and loopback targets for http and CONNECT unless allowed", async () => {
    const proxy = await startEgressProxy({ allowPrivateNetwork: false });
    const viaProxy = (target: string) =>
      new Promise<number>((resolve, reject) => {
        const url = new URL(proxy.url);
        http.get({ host: url.hostname, port: url.port, path: target, headers: { host: new URL(target).host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on("error", reject);
      });
    expect(await viaProxy(`${base}/`)).toBe(403);
    expect(await viaProxy("http://169.254.169.254/latest/meta-data/")).toBe(403);
    expect(await viaProxy("http://localhost/")).toBe(403);
    await proxy.close();

    const open = await startEgressProxy({ allowPrivateNetwork: true });
    const url = new URL(open.url);
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: url.hostname, port: url.port, path: `${base}/two`, headers: { host: new URL(base).host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    expect(status).toBe(200);
    await open.close();
  });
});

describe("browser tools", () => {
  let manager: BrowserManager;
  const frames: BrowserFrame[] = [];

  beforeAll(() => {
    manager = new BrowserManager({ enabled: true, allowPrivateNetwork: true, maxSessions: 2, onFrame: (f) => frames.push(f) });
  });
  afterEach(async () => {
    await manager.closeAll();
  });
  afterAll(async () => {
    await manager.shutdown();
  });

  it("opens pages, lists numbered elements, fills forms, clicks, goes back and reports activity", async () => {
    const { run, activities } = harness(manager);
    const opened = await run("browser.open", { url: `${base}/` });
    expect(opened.summary).toBe("Opened Demo");
    expect(opened.content).toContain('[1] input "Name" value=""');
    expect(opened.content).toContain("[2] input[type=password]");
    expect(opened.content).toContain('[3] select "A"');
    expect(opened.content).toContain('[4] button "Go"');
    expect(opened.content).not.toMatch(/\[\d+\] a "Hidden"/);
    expect(opened.content).toContain("# Hello");

    await run("browser.type", { index: 1, text: "hello" });
    await run("browser.type", { index: 2, text: "secret" });
    const snap = await run("browser.snapshot", {});
    expect(snap.content).toContain('value="hello"');
    expect(snap.content).toContain('value="••••"');
    expect(snap.content).not.toContain("secret");

    await run("browser.select", { index: 3, option: "B" });
    const clicked = await run("browser.click", { index: 4 });
    expect(clicked.output).toMatchObject({ url: `${base}/two?q=hello&p=secret&s=B`, title: "Two" });
    expect(clicked.content).toContain("q=hello s=B");

    const back = await run("browser.back", {});
    expect((back.output as { url: string }).url).toBe(`${base}/`);

    const types = activities.map((a) => a.type);
    expect(types[0]).toBe("BROWSER_OPENED");
    expect(types).toEqual(expect.arrayContaining(["PAGE_NAVIGATED", "BROWSER_ACTION", "BROWSER_SCREENSHOT"]));
    const shot = activities.find((a) => a.type === "BROWSER_SCREENSHOT");
    expect(shot).toMatchObject({ mimeType: "image/jpeg", width: 1280, height: 800 });
    expect(shot && shot.type === "BROWSER_SCREENSHOT" && shot.image.length).toBeGreaterThan(1000);
    const click = activities.find((a) => a.type === "BROWSER_ACTION" && a.action === "click");
    expect(click).toMatchObject({ target: '[4] button "Go"' });
    expect(manager.latestFrame("task-1")?.frame.url).toContain(base);
    expect(frames.length).toBeGreaterThan(0);
  });

  it("rejects stale element numbers and actions without a page", async () => {
    const { run } = harness(manager, "task-stale");
    await expect(run("browser.click", { index: 1 })).rejects.toMatchObject({ code: "invalid_input" });
    await run("browser.open", { url: `${base}/` });
    await expect(run("browser.click", { index: 99 })).rejects.toMatchObject({ code: "not_found" });
    await run("browser.close", {});
    expect(manager.get("task-stale")).toBeUndefined();
  });

  it("scrolls, dismisses dialogs and takes full-page screenshots", async () => {
    const { run, activities } = harness(manager, "task-scroll");
    const opened = await run("browser.open", { url: `${base}/long` });
    expect(opened.content).toContain("(off-screen)");
    const scrolled = await run("browser.scroll", { direction: "bottom" });
    expect((scrolled.output as { scrollY: number }).scrollY).toBeGreaterThan(1000);
    const full = await run("browser.screenshot", { fullPage: true });
    expect((full.output as { height: number }).height).toBeGreaterThan(800);

    const dialog = await run("browser.open", { url: `${base}/dialog` });
    expect(dialog.content).toContain("Dialogs dismissed: alert: hi");
    await run("browser.click", { index: 1 });
    expect(activities.filter((a) => a.type === "BROWSER_SCREENSHOT").length).toBeGreaterThanOrEqual(4);
    await run("browser.close", {});
  });

  it("closes the session when the task is stopped", async () => {
    const { run, controller } = harness(manager, "task-abort");
    await run("browser.open", { url: `${base}/` });
    expect(manager.get("task-abort")).toBeDefined();
    const pending = run("browser.open", { url: `${base}/long` });
    controller.abort();
    await pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.get("task-abort")?.closed ?? true).toBe(true);
  });

  it("limits concurrent sessions", async () => {
    const a = harness(manager, "task-a");
    const b = harness(manager, "task-b");
    const c = harness(manager, "task-c");
    await a.run("browser.open", { url: `${base}/` });
    await b.run("browser.open", { url: `${base}/` });
    await expect(c.run("browser.open", { url: `${base}/` })).rejects.toMatchObject({ code: "unavailable" });
    await a.run("browser.close", {});
    await b.run("browser.close", {});
  });
});

describe("browser network guard", () => {
  it("blocks private addresses, including through redirects, and reports unavailability when disabled", async () => {
    const strict = new BrowserManager({ enabled: true, allowPrivateNetwork: false });
    const { run, tools } = harness(strict, "task-ssrf");
    await expect(run("browser.open", { url: `${base}/` })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(run("browser.open", { url: "http://169.254.169.254/latest/meta-data/" })).rejects.toMatchObject({ code: "permission_denied" });
    expect(() => tools["browser.open"]!.inputSchema.parse({ url: "file:///etc/passwd" })).toThrow();
    await strict.shutdown();

    // A public page that redirects to a private address is blocked at the proxy.
    const permissive = new BrowserManager({ enabled: true, allowPrivateNetwork: true });
    const redirected = harness(permissive, "task-redirect");
    const result = await redirected.run("browser.open", { url: `${base}/redirect-private` }).catch((e: unknown) => e);
    expect(result).toBeTruthy();
    await permissive.shutdown();

    const disabled = new BrowserManager({ enabled: false });
    expect(disabled.availability()).toMatchObject({ available: false });
    await expect(harness(disabled).run("browser.open", { url: "https://example.com" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("formats snapshots with truncation", () => {
    const text = formatSnapshot({ url: "u", title: "", elements: [], text: "x".repeat(10), scrollY: 0, scrollHeight: 100, viewportHeight: 50, truncatedElements: true }, 5);
    expect(text).toContain("Title: (none)");
    expect(text).toContain("(none found)");
    expect(text).toContain("more elements not listed");
    expect(text).toContain("page text truncated");
  });
});
