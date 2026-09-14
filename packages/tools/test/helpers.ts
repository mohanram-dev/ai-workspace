import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolActivity, ToolContext } from "../src";
import { Workspace } from "../src";

export async function tempWorkspace() {
  const base = await mkdtemp(path.join(os.tmpdir(), "aiw-tools-"));
  const workspace = new Workspace(path.join(base, "ws"));
  await workspace.ensure();
  return { base, workspace, cleanup: () => rm(base, { recursive: true, force: true }) };
}

export function context(workspace: Workspace, signal = new AbortController().signal) {
  const activities: ToolActivity[] = [];
  const output: { stream: string; text: string }[] = [];
  const ctx: ToolContext = {
    taskId: "task",
    userId: "user",
    workspace,
    signal,
    report: (activity) => activities.push(activity),
    output: (stream, text) => output.push({ stream, text }),
  };
  return { ctx, activities, output };
}
