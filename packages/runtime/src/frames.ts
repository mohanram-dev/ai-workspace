import type { FrameKind } from "@aiw/queue";
import { getQueueRuntime } from "./queue";

/**
 * In queue mode the browser and desktop run in the worker, so the newest preview
 * frame is copied to Redis for the web tier to serve. In single-process mode
 * this does nothing: the manager in this process already holds the frame.
 */
export function publishFrame(kind: FrameKind, taskId: string, latest: { image: Buffer; frame: { seq: number; url?: string } } | null): void {
  const queue = getQueueRuntime();
  if (!queue || !latest) return;
  void queue.frames
    .put(kind, taskId, { image: latest.image, seq: latest.frame.seq, url: latest.frame.url ?? "" })
    .catch((error: unknown) => console.error("Could not publish a live frame", error));
}

/** The newest frame from whichever process produced it, or null. */
export async function readPublishedFrame(kind: FrameKind, taskId: string) {
  return (await getQueueRuntime()?.frames.get(kind, taskId)) ?? null;
}
