import { z } from "zod";
import { ToolError, type AnyToolDefinition, type ComputerActionKind, type ToolContext, type ToolDefinition, type ToolResult } from "@aiw/tools";
import type { ComputerManager, ComputerSession } from "./manager";

const TOOL_TIMEOUT_MS = 60_000;
const KEY_NAMES = /^(?:[a-z0-9]|f[1-9]|f1[0-2]|enter|return|tab|escape|esc|backspace|delete|del|insert|space|home|end|pageup|pagedown|up|down|left|right|ctrl|control|alt|shift)$/i;
const coord = z.number().int().min(0).max(20000);

function requireSession(manager: ComputerManager, taskId: string): ComputerSession {
  const session = manager.get(taskId);
  if (!session || session.closed) throw new ToolError("invalid_input", "Computer control is not started. Use computer.start first.");
  return session;
}

/** Capture the screen and return it to the model as an image plus a short text note. */
async function screenResult(session: ComputerSession, context: ToolContext, reason: string, note: string): Promise<ToolResult> {
  const shot = await session.capture();
  context.report({ type: "COMPUTER_SCREENSHOT", width: shot.width, height: shot.height, mimeType: "image/jpeg", image: shot.image, reason });
  const cursor = await session.cursor().catch(() => null);
  return {
    output: { width: shot.width, height: shot.height, cursor },
    summary: note,
    content: [
      note,
      `Screen: ${shot.width}×${shot.height} px (coordinates are in these pixels; 0,0 is top-left).`,
      cursor ? `Cursor at ${cursor.x},${cursor.y}.` : "",
      "The attached screenshot shows the current screen.",
    ]
      .filter(Boolean)
      .join(" "),
    images: [{ mimeType: "image/jpeg", data: shot.image }],
  };
}

function guarded<T>(context: ToolContext, operation: () => Promise<T>): Promise<T> {
  if (context.signal.aborted) throw new ToolError("cancelled", "Stopped.");
  return operation();
}

function define<Input>(definition: Omit<ToolDefinition<Input>, "category" | "timeoutMs" | "availability">, manager: ComputerManager): ToolDefinition<Input> {
  return { ...definition, category: "computer", timeoutMs: TOOL_TIMEOUT_MS, availability: () => manager.availability() };
}

const buttonSchema = z.enum(["left", "right", "middle"]).default("left");

/**
 * Computer-use tools: the model looks at a screenshot and drives the real
 * mouse and keyboard by pixel coordinates. One task controls the desktop at a time.
 */
export function createComputerTools(manager: ComputerManager): AnyToolDefinition[] {
  const action = async (
    context: ToolContext,
    kind: ComputerActionKind,
    target: string,
    perform: (session: ComputerSession) => Promise<void>,
    note: string,
    reason = kind,
  ) =>
    guarded(context, async () => {
      const session = requireSession(manager, context.taskId);
      context.report({ type: "COMPUTER_ACTION", action: kind, target });
      await perform(session);
      // Let the UI settle before capturing the result.
      await new Promise((resolve) => setTimeout(resolve, 350));
      return screenResult(session, context, reason, note);
    });

  const tools: AnyToolDefinition[] = [
    define(
      {
        name: "computer.start",
        description:
          "Start controlling the computer's desktop (screen, mouse, keyboard) and take the first screenshot. Only one task can control the computer at a time. Look at the screenshot before acting.",
        inputSchema: z.object({}),
        permission: "EXECUTE",
        execute: (_input: Record<string, never>, context) =>
          guarded(context, async () => {
            const { session, created } = await manager.open(context.taskId);
            if (created) context.report({ type: "COMPUTER_STARTED", platform: session.platform, screenWidth: session.screen.width, screenHeight: session.screen.height });
            return screenResult(session, context, "start", created ? `Started controlling the ${session.platform} desktop.` : "Already controlling the desktop.");
          }),
      },
      manager,
    ),
    define(
      {
        name: "computer.screenshot",
        description: "Take a fresh screenshot of the desktop to see the current state. Do this whenever you are unsure what is on screen.",
        inputSchema: z.object({}),
        permission: "READ",
        execute: (_input: Record<string, never>, context) =>
          guarded(context, async () => screenResult(requireSession(manager, context.taskId), context, "requested", "Current screen.")),
      },
      manager,
    ),
    define(
      {
        name: "computer.click",
        description: "Move the mouse to (x, y) in screenshot pixels and click. Use button for right/middle, and count 2 for a double-click.",
        inputSchema: z.object({ x: coord, y: coord, button: buttonSchema, count: z.number().int().min(1).max(3).default(1) }),
        permission: "EXECUTE",
        execute: (input: { x: number; y: number; button: "left" | "right" | "middle"; count: number }, context) => {
          const kind: ComputerActionKind = input.count >= 2 ? "double_click" : input.button === "right" ? "right_click" : "click";
          const verb = input.count >= 2 ? "Double-clicked" : `${input.button[0]!.toUpperCase()}${input.button.slice(1)}-clicked`;
          return action(context, kind, `${input.x},${input.y}`, (s) => s.click(input.x, input.y, input.button, input.count), `${verb} at ${input.x},${input.y}.`);
        },
      },
      manager,
    ),
    define(
      {
        name: "computer.move",
        description: "Move the mouse to (x, y) without clicking (e.g. to reveal a hover state).",
        inputSchema: z.object({ x: coord, y: coord }),
        permission: "EXECUTE",
        execute: (input: { x: number; y: number }, context) => action(context, "move", `${input.x},${input.y}`, (s) => s.move(input.x, input.y), `Moved to ${input.x},${input.y}.`),
      },
      manager,
    ),
    define(
      {
        name: "computer.drag",
        description: "Press the mouse at (fromX, fromY), move to (toX, toY) and release. Use for selecting text, dragging sliders or moving items.",
        inputSchema: z.object({ fromX: coord, fromY: coord, toX: coord, toY: coord, button: buttonSchema }),
        permission: "EXECUTE",
        execute: (input: { fromX: number; fromY: number; toX: number; toY: number; button: "left" | "right" | "middle" }, context) =>
          action(context, "drag", `${input.fromX},${input.fromY} → ${input.toX},${input.toY}`, (s) => s.drag(input.fromX, input.fromY, input.toX, input.toY, input.button), `Dragged from ${input.fromX},${input.fromY} to ${input.toX},${input.toY}.`),
      },
      manager,
    ),
    define(
      {
        name: "computer.scroll",
        description: "Scroll at (x, y). Positive amount scrolls down, negative up; horizontal moves right/left. Units are wheel notches.",
        inputSchema: z.object({ x: coord, y: coord, amount: z.number().int().min(-30).max(30).default(3), horizontal: z.boolean().default(false) }),
        permission: "EXECUTE",
        execute: (input: { x: number; y: number; amount: number; horizontal: boolean }, context) =>
          action(
            context,
            "scroll",
            `${input.x},${input.y}`,
            (s) => (input.horizontal ? s.scroll(input.x, input.y, input.amount, 0) : s.scroll(input.x, input.y, 0, input.amount)),
            `Scrolled ${input.horizontal ? (input.amount > 0 ? "right" : "left") : input.amount > 0 ? "down" : "up"} at ${input.x},${input.y}.`,
          ),
      },
      manager,
    ),
    define(
      {
        name: "computer.type",
        description: "Type text at the current keyboard focus. Click the field first. Use \\n for Enter.",
        inputSchema: z.object({ text: z.string().min(1).max(5000) }),
        permission: "EXECUTE",
        execute: (input: { text: string }, context) =>
          action(context, "type", `${input.text.length} chars`, (s) => s.type(input.text), `Typed ${input.text.length} characters.`),
      },
      manager,
    ),
    define(
      {
        name: "computer.key",
        description:
          "Press a key or a shortcut, given as keys held together, e.g. [\"ctrl\",\"c\"] or [\"enter\"]. Names: letters, digits, enter, tab, escape, backspace, delete, arrows, home, end, pageup, pagedown, f1–f12, and modifiers ctrl, alt, shift. The Windows/Super key is not available.",
        inputSchema: z.object({ keys: z.array(z.string().regex(KEY_NAMES, "Unknown key name")).min(1).max(4) }),
        permission: "EXECUTE",
        execute: (input: { keys: string[] }, context) =>
          action(context, "key", input.keys.join("+"), (s) => s.key(input.keys), `Pressed ${input.keys.join("+")}.`),
      },
      manager,
    ),
    define(
      {
        name: "computer.wait",
        description: "Wait a moment (up to 10 seconds) for the screen to update, then take a screenshot. Use after starting an app or a slow action.",
        inputSchema: z.object({ seconds: z.number().min(0.5).max(10).default(2) }),
        permission: "READ",
        execute: (input: { seconds: number }, context) =>
          action(context, "wait", `${input.seconds}s`, () => new Promise((resolve) => setTimeout(resolve, input.seconds * 1000)), `Waited ${input.seconds}s.`, "wait"),
      },
      manager,
    ),
    define(
      {
        name: "computer.stop",
        description: "Stop controlling the computer. It also stops automatically when the task ends.",
        inputSchema: z.object({}),
        permission: "READ",
        execute: async (_input: Record<string, never>, context) => {
          const closed = await manager.close(context.taskId);
          if (closed) context.report({ type: "COMPUTER_STOPPED" });
          return { output: { closed }, summary: closed ? "Stopped controlling the computer" : "Was not controlling the computer", content: closed ? "Stopped." : "Was not controlling the computer." };
        },
      },
      manager,
    ),
  ];
  return tools;
}

export const COMPUTER_TOOL_NAMES = [
  "computer.start",
  "computer.screenshot",
  "computer.click",
  "computer.move",
  "computer.drag",
  "computer.scroll",
  "computer.type",
  "computer.key",
  "computer.wait",
  "computer.stop",
] as const;
