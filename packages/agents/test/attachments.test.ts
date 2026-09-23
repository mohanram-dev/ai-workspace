import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getMessageForTask, getTask, listAgentsForUser, listMessages, updateAgentForUser, type DatabaseHandle } from "@aiw/database";
import type { MessageAttachment } from "@aiw/shared";
import { makePdf } from "@aiw/tools/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntime, ensureBuiltinAgents, InProcessTaskExecutor, TaskService } from "../src";
import { createUser, eventRecorder, openTestDatabase, registryFor, ScriptedProvider } from "./helpers";

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let handle: DatabaseHandle;
let root: string;
beforeAll(async () => {
  handle = openTestDatabase();
  root = await mkdtemp(path.join(os.tmpdir(), "aiw-task-attachments-"));
});
afterAll(async () => {
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

const attachment = (name: string, mimeType: string): MessageAttachment => ({ path: `chat-uploads/${name}`, name, mimeType, size: 1, projectId: null });

async function setup(files: Record<string, Buffer>) {
  const provider = new ScriptedProvider((_request, kind) => (kind === "planning" ? JSON.stringify({ steps: [{ title: "Look", instruction: "Describe it." }] }) : "Seen."));
  const registry = registryFor(provider);
  const { events } = eventRecorder(handle);
  const runtime = new AgentRuntime({ db: handle.db, registry, events, retryDelaysMs: [], workspaceRoot: root });
  const executor = new InProcessTaskExecutor(runtime);
  const service = new TaskService({ db: handle.db, registry, executor, events, maxRunningTasksPerUser: 3 });
  const userId = await createUser(handle);
  await ensureBuiltinAgents(handle.db, userId);
  const general = (await listAgentsForUser(handle.db, userId)).find((a) => a.slug === "general")!;
  // No tools at all: attachments must reach an agent that cannot open files itself.
  await updateAgentForUser(handle.db, userId, general.id, { provider: "scripted", tools: [] });
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(root, "users", userId, "chat-uploads", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  return { provider, executor, service, userId, agentId: general.id };
}

describe("task attachments (spec §3)", () => {
  it("shows the agent attached pictures and documents in planning and in every step", async () => {
    const { provider, executor, service, userId, agentId } = await setup({ "photo.png": PNG, "brief.pdf": makePdf(["Launch on Friday"]) });
    const { task } = await service.createTask(userId, {
      prompt: "What do these show?",
      agentId,
      attachments: [attachment("photo.png", "image/png"), attachment("brief.pdf", "application/pdf"), attachment("gone.txt", "text/plain")],
    });
    expect(await executor.waitFor(task.id)).toBe("completed");

    const image = { mimeType: "image/png", data: PNG.toString("base64") };
    const planning = provider.calls("planning")[0]!.request.messages.at(-1)!;
    const step = provider.calls("step")[0]!.request.messages.at(-1)!;
    expect(planning).toMatchObject({ images: [image] });
    expect(step).toMatchObject({ images: [image] });

    const prompt = step.content;
    expect(prompt).toContain("## Attached files");
    expect(prompt).toContain("- photo.png (image/png), in your workspace at chat-uploads/photo.png");
    expect(prompt).toContain("The attached image is included with this message.");
    expect(prompt).toContain("--- Attached PDF: brief.pdf, 1 page ---\n--- Page 1 ---\nLaunch on Friday");
    // A file that has gone is reported, not skipped silently.
    expect(prompt).toContain('[Attached file "gone.txt" is no longer in the workspace.]');
  });

  it("keeps the attachments on the task and its message, and on a retry", async () => {
    const { executor, service, userId, agentId } = await setup({ "photo.png": PNG });
    const attachments = [attachment("photo.png", "image/png")];
    const created = await service.createTask(userId, { prompt: "Describe this", agentId, attachments });
    await executor.waitFor(created.task.id);

    expect((await getTask(handle.db, created.task.id))?.attachments).toEqual(attachments);
    const messages = await listMessages(handle.db, created.conversation.id);
    expect(messages.find((m) => m.role === "user")?.attachments).toEqual(attachments);
    // The stored prompt is what the user typed; the files are not pasted into it.
    expect(created.task.prompt).toBe("Describe this");

    const retry = await service.retryTask(userId, created.task.id);
    expect(retry.attachments).toEqual(attachments);
    await executor.waitFor(retry.id);
    expect((await getMessageForTask(handle.db, retry.id))?.status).toBe("completed");
  });

  it("does not add an attachment section to a task without attachments", async () => {
    const { provider, executor, service, userId, agentId } = await setup({});
    const { task } = await service.createTask(userId, { prompt: "Plain question", agentId });
    await executor.waitFor(task.id);
    const step = provider.calls("step")[0]!.request.messages.at(-1)!;
    expect(step.content).not.toContain("## Attached files");
    expect(step).not.toHaveProperty("images");
  });
});
