import { z } from "zod";
import { ToolError, type AnyToolDefinition, type BrowserActionKind, type ToolContext, type ToolDefinition, type ToolResult } from "@aiw/tools";
import { toBrowserError, type BrowserManager, type BrowserSession } from "./manager";
import { describeElement, formatSnapshot } from "./snapshot";

const TOOL_TIMEOUT_MS = 60_000;
const KEYS = ["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Space"] as const;

/** Runs a browser operation; an abort (stop, time limit) closes the session so pending operations end. */
async function guarded<T>(manager: BrowserManager, context: ToolContext, operation: () => Promise<T>): Promise<T> {
  if (context.signal.aborted) throw new ToolError("cancelled", "Stopped.");
  const onAbort = () => void manager.close(context.taskId);
  context.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await operation();
  } catch (error) {
    throw toBrowserError(error);
  } finally {
    context.signal.removeEventListener("abort", onAbort);
  }
}

function requireSession(manager: BrowserManager, taskId: string): BrowserSession {
  const session = manager.get(taskId);
  if (!session || session.closed) throw new ToolError("invalid_input", "No browser page is open. Use browser.open with a URL first.");
  return session;
}

/** After an action: report navigation, store a screenshot, and return the new page state to the model. */
async function pageResult(session: BrowserSession, context: ToolContext, reason: string, beforeUrl: string | null, summary: string): Promise<ToolResult> {
  const snapshot = await session.snapshot();
  if (snapshot.url !== beforeUrl) context.report({ type: "PAGE_NAVIGATED", url: snapshot.url, title: snapshot.title || null });
  try {
    const shot = await session.screenshot();
    context.report({ type: "BROWSER_SCREENSHOT", url: snapshot.url, title: snapshot.title || null, width: shot.width, height: shot.height, mimeType: "image/jpeg", image: shot.image, reason });
  } catch {
    // A missing screenshot must not fail the action.
  }
  const dialogs = session.dialogs.splice(0);
  const content = [...(dialogs.length ? [`Dialogs dismissed: ${dialogs.join("; ")}`, ""] : []), formatSnapshot(snapshot)].join("\n");
  return {
    output: { url: snapshot.url, title: snapshot.title, elements: snapshot.elements.length, scrollY: snapshot.scrollY, dialogs },
    summary,
    content,
  };
}

function define<Input>(definition: Omit<ToolDefinition<Input>, "category" | "timeoutMs" | "availability">, manager: BrowserManager): ToolDefinition<Input> {
  return { ...definition, category: "browser", timeoutMs: TOOL_TIMEOUT_MS, availability: () => manager.availability() };
}

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Use an absolute http(s) URL without credentials.");

const SCROLL_SCRIPT = String.raw`(direction) => {
  const step = window.innerHeight * 0.85;
  if (direction === "top") window.scrollTo(0, 0);
  else if (direction === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
  else window.scrollBy(0, direction === "down" ? step : -step);
}`;

const indexSchema = z.number().int().min(1).describe("Element number from the latest page snapshot");

/**
 * Browser tools (Browser Use style): the model sees numbered interactive
 * elements and page text, and acts on elements by number.
 */
export function createBrowserTools(manager: BrowserManager): AnyToolDefinition[] {
  const action = async (
    context: ToolContext,
    kind: BrowserActionKind,
    target: (session: BrowserSession) => string,
    perform: (session: BrowserSession) => Promise<void>,
    summary: (targetText: string) => string,
  ) =>
    guarded(manager, context, async () => {
      const session = requireSession(manager, context.taskId);
      const beforeUrl = session.page.url();
      const targetText = target(session);
      context.report({ type: "BROWSER_ACTION", action: kind, target: targetText, url: beforeUrl });
      await perform(session);
      await session.settle();
      return pageResult(session, context, kind, beforeUrl, summary(targetText));
    });

  const elementTarget = (index: number) => (session: BrowserSession) => {
    session.element(index);
    return describeElement(session.elements.get(index)!);
  };

  const tools: AnyToolDefinition[] = [
    define(
      {
        name: "browser.open",
        description:
          "Open a URL in your browser (a real Chromium with its own clean session) and get the page: numbered interactive elements and readable text. Starts the browser if needed.",
        inputSchema: z.object({ url: httpUrl }),
        permission: "NETWORK",
        execute: (input: { url: string }, context) =>
          guarded(manager, context, async () => {
            const { session, created } = await manager.open(context.taskId);
            if (created) context.report({ type: "BROWSER_OPENED" });
            const beforeUrl = session.page.url();
            await session.goto(input.url);
            const result = await pageResult(session, context, "open", beforeUrl, "");
            const output = result.output as { title: string; url: string };
            return { ...result, summary: `Opened ${output.title || output.url}` };
          }),
      },
      manager,
    ),
    define(
      {
        name: "browser.snapshot",
        description: "Get the current page again: URL, numbered interactive elements and readable text. Element numbers change after the page changes.",
        inputSchema: z.object({}),
        permission: "READ",
        execute: (_input: Record<string, never>, context) =>
          guarded(manager, context, async () => {
            const session = requireSession(manager, context.taskId);
            const snapshot = await session.snapshot();
            return {
              output: { url: snapshot.url, title: snapshot.title, elements: snapshot.elements.length },
              summary: `Read ${snapshot.title || snapshot.url} (${snapshot.elements.length} elements)`,
              content: formatSnapshot(snapshot),
            };
          }),
      },
      manager,
    ),
    define(
      {
        name: "browser.click",
        description: "Click an element by its number from the latest snapshot. Returns the updated page.",
        inputSchema: z.object({ index: indexSchema }),
        permission: "EXECUTE",
        execute: (input: { index: number }, context) =>
          action(context, "click", elementTarget(input.index), (s) => s.element(input.index).click(), (t) => `Clicked ${t}`),
      },
      manager,
    ),
    define(
      {
        name: "browser.type",
        description: "Type text into an input, textarea or editable element by number (replacing its content). Set submit to press Enter afterwards.",
        inputSchema: z.object({ index: indexSchema, text: z.string().max(2000), submit: z.boolean().default(false) }),
        permission: "EXECUTE",
        execute: (input: { index: number; text: string; submit: boolean }, context) =>
          action(
            context,
            "type",
            elementTarget(input.index),
            async (s) => {
              const locator = s.element(input.index);
              await locator.fill(input.text);
              if (input.submit) await locator.press("Enter");
            },
            (t) => `Typed ${input.text.length} characters into ${t}${input.submit ? " and pressed Enter" : ""}`,
          ),
      },
      manager,
    ),
    define(
      {
        name: "browser.select",
        description: "Choose an option in a <select> element by number, using the option's visible label or value.",
        inputSchema: z.object({ index: indexSchema, option: z.string().min(1).max(500) }),
        permission: "EXECUTE",
        execute: (input: { index: number; option: string }, context) =>
          action(
            context,
            "select",
            elementTarget(input.index),
            async (s) => {
              const locator = s.element(input.index);
              const byLabel = await locator.selectOption({ label: input.option }).catch(() => null);
              if (!byLabel?.length) await locator.selectOption(input.option);
            },
            (t) => `Selected "${input.option}" in ${t}`,
          ),
      },
      manager,
    ),
    define(
      {
        name: "browser.press",
        description: `Press a key on the focused element: ${KEYS.join(", ")}.`,
        inputSchema: z.object({ key: z.enum(KEYS) }),
        permission: "EXECUTE",
        execute: (input: { key: (typeof KEYS)[number] }, context) =>
          action(context, "press", () => input.key, (s) => s.page.keyboard.press(input.key === "Space" ? " " : input.key), () => `Pressed ${input.key}`),
      },
      manager,
    ),
    define(
      {
        name: "browser.scroll",
        description: "Scroll the page up or down by one screen, or to the top or bottom.",
        inputSchema: z.object({ direction: z.enum(["down", "up", "top", "bottom"]) }),
        permission: "NETWORK",
        execute: (input: { direction: "down" | "up" | "top" | "bottom" }, context) =>
          action(
            context,
            "scroll",
            () => input.direction,
            (s) => s.page.evaluate(`(${SCROLL_SCRIPT})(${JSON.stringify(input.direction)})`).then(() => undefined),
            () => `Scrolled ${input.direction}`,
          ),
      },
      manager,
    ),
    define(
      {
        name: "browser.back",
        description: "Go back to the previous page.",
        inputSchema: z.object({}),
        permission: "NETWORK",
        execute: (_input: Record<string, never>, context) =>
          action(context, "back", (s) => s.page.url(), async (s) => void (await s.page.goBack({ waitUntil: "domcontentloaded" })), () => "Went back"),
      },
      manager,
    ),
    define(
      {
        name: "browser.screenshot",
        description: "Save a screenshot of the current page (visible area, or the full page) to the task. The image is shown to the user, not to you.",
        inputSchema: z.object({ fullPage: z.boolean().default(false) }),
        permission: "READ",
        execute: (input: { fullPage: boolean }, context) =>
          guarded(manager, context, async () => {
            const session = requireSession(manager, context.taskId);
            const shot = await session.screenshot(input.fullPage);
            const url = session.page.url();
            context.report({ type: "BROWSER_SCREENSHOT", url, title: session.currentTitle || null, width: shot.width, height: shot.height, mimeType: "image/jpeg", image: shot.image, reason: "requested" });
            return {
              output: { url, width: shot.width, height: shot.height, bytes: shot.image.length, fullPage: input.fullPage },
              summary: `Saved a ${input.fullPage ? "full-page" : "viewport"} screenshot of ${session.currentTitle || url}`,
              content: `Screenshot saved to the task (${shot.width}×${shot.height}). You cannot see images; use browser.snapshot to read the page.`,
            };
          }),
      },
      manager,
    ),
    define(
      {
        name: "browser.close",
        description: "Close the browser session when you no longer need it. It also closes automatically when the task ends.",
        inputSchema: z.object({}),
        permission: "READ",
        execute: async (_input: Record<string, never>, context) => {
          const closed = await manager.close(context.taskId);
          if (closed) context.report({ type: "BROWSER_CLOSED" });
          return { output: { closed }, summary: closed ? "Closed the browser" : "No browser was open", content: closed ? "Browser closed." : "No browser was open." };
        },
      },
      manager,
    ),
  ];
  return tools;
}

export const BROWSER_TOOL_NAMES = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.press",
  "browser.scroll",
  "browser.back",
  "browser.screenshot",
  "browser.close",
] as const;

