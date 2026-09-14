import os from "node:os";
import { Workspace, type ToolActivity, type ToolContext } from "@aiw/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerManager, createComputerTools, type ComputerDriver, type ComputerFrame } from "../src";

/** In-memory fake desktop: records actions and renders a 1×1 "screenshot". */
class FakeDriver implements ComputerDriver {
  readonly platform = "fake";
  started = false;
  stopped = false;
  cursorPos = { x: 400, y: 300 };
  readonly log: string[] = [];
  screenSize = { width: 1920, height: 1080, left: 0, top: 0 };

  async start() {
    this.started = true;
    return this.screenSize;
  }
  async stop() {
    this.stopped = true;
  }
  async screen() {
    return this.screenSize;
  }
  async screenshot(maxWidth: number) {
    const scale = this.screenSize.width > maxWidth ? maxWidth / this.screenSize.width : 1;
    return {
      image: Buffer.from(`img@${maxWidth}`),
      width: Math.round(this.screenSize.width * scale),
      height: Math.round(this.screenSize.height * scale),
      scale,
      screen: this.screenSize,
    };
  }
  async cursor() {
    return this.cursorPos;
  }
  async move(x: number, y: number) {
    this.cursorPos = { x, y };
    this.log.push(`move ${x},${y}`);
  }
  async click(x: number, y: number, button: string, count: number) {
    this.log.push(`click ${button}x${count} ${x},${y}`);
  }
  async drag(fromX: number, fromY: number, toX: number, toY: number, button: string) {
    this.log.push(`drag ${button} ${fromX},${fromY}->${toX},${toY}`);
  }
  async scroll(x: number, y: number, dx: number, dy: number) {
    this.log.push(`scroll ${x},${y} ${dx},${dy}`);
  }
  async type(text: string) {
    this.log.push(`type ${text}`);
  }
  async key(keys: string[]) {
    this.log.push(`key ${keys.join("+")}`);
  }
}

function harness(manager: ComputerManager, taskId = "task-1") {
  const tools = Object.fromEntries(createComputerTools(manager).map((t) => [t.name, t]));
  const activities: ToolActivity[] = [];
  const controller = new AbortController();
  const ctx: ToolContext = { taskId, userId: "u", workspace: new Workspace(os.tmpdir()), signal: controller.signal, report: (a) => activities.push(a), output: () => {} };
  const run = (name: string, input: unknown) => tools[name]!.execute(tools[name]!.inputSchema.parse(input), ctx);
  return { tools, activities, controller, run };
}

describe("computer tools", () => {
  let manager: ComputerManager;
  afterEach(async () => {
    await manager?.shutdown();
    vi.useRealTimers();
  });

  it("starts control, returns screenshots as images and maps coordinates to the screen", async () => {
    const driver = new FakeDriver();
    const frames: ComputerFrame[] = [];
    manager = new ComputerManager({ enabled: true, maxWidth: 960, createDriver: () => driver, onFrame: (f) => frames.push(f) });
    const { run, activities } = harness(manager);

    const started = await run("computer.start", {});
    expect(driver.started).toBe(true);
    expect(started.images?.[0]).toMatchObject({ mimeType: "image/jpeg" });
    expect(started.content).toContain("960×540");
    expect(activities[0]).toMatchObject({ type: "COMPUTER_STARTED", platform: "fake", screenWidth: 1920 });
    expect(activities.find((a) => a.type === "COMPUTER_SCREENSHOT")).toMatchObject({ width: 960, height: 540 });

    // Screenshot is 960 wide for a 1920 screen: scale 0.5, so a click at 100,100 hits 200,200 on screen.
    await run("computer.click", { x: 100, y: 100 });
    expect(driver.log).toContain("click leftx1 200,200");
    await run("computer.click", { x: 10, y: 20, button: "right", count: 2 });
    expect(driver.log).toContain("click rightx2 20,40");
    await run("computer.drag", { fromX: 0, fromY: 0, toX: 50, toY: 50 });
    expect(driver.log).toContain("drag left 0,0->100,100");
    await run("computer.type", { text: "hi" });
    await run("computer.key", { keys: ["ctrl", "s"] });
    await run("computer.scroll", { x: 5, y: 5, amount: 3 });
    expect(driver.log).toEqual(expect.arrayContaining(["type hi", "key ctrl+s", "scroll 10,10 0,3"]));

    const actionTypes = activities.filter((a) => a.type === "COMPUTER_ACTION").map((a) => (a.type === "COMPUTER_ACTION" ? a.action : ""));
    expect(actionTypes).toEqual(["click", "double_click", "drag", "type", "key", "scroll"]);
    expect(frames.length).toBeGreaterThanOrEqual(7);
    expect(manager.latestFrame("task-1")?.frame.width).toBe(960);
  });

  it("rejects unknown keys and actions before starting", async () => {
    manager = new ComputerManager({ enabled: true, createDriver: () => new FakeDriver() });
    const { tools, run } = harness(manager);
    await expect(run("computer.click", { x: 1, y: 1 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(() => tools["computer.key"]!.inputSchema.parse({ keys: ["ctrl", "notakey"] })).toThrow();
  });

  it("allows only one task to control the desktop at a time", async () => {
    manager = new ComputerManager({ enabled: true, createDriver: () => new FakeDriver() });
    await harness(manager, "task-a").run("computer.start", {});
    await expect(harness(manager, "task-b").run("computer.start", {})).rejects.toMatchObject({ code: "unavailable" });
    expect(await manager.close("task-a")).toBe(true);
    await harness(manager, "task-b").run("computer.start", {});
    expect(manager.get("task-b")).toBeDefined();
  });

  it("stops the driver when closed and reports unavailability when disabled", async () => {
    const driver = new FakeDriver();
    manager = new ComputerManager({ enabled: true, createDriver: () => driver });
    const { run } = harness(manager, "task-x");
    await run("computer.start", {});
    const stopped = await run("computer.stop", {});
    expect(stopped.output).toMatchObject({ closed: true });
    expect(driver.stopped).toBe(true);

    const off = new ComputerManager({ enabled: false, createDriver: () => new FakeDriver() });
    expect(off.availability()).toMatchObject({ available: false });
    await expect(harness(off).run("computer.start", {})).rejects.toMatchObject({ code: "unavailable" });
  });
});
