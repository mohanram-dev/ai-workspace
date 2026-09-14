import { getDatabase, pingDatabase } from "@aiw/database";
import { getQueueRuntime } from "@aiw/runtime";

/**
 * GET /api/ready — readiness for an orchestrator (spec §44). Unlike /api/health
 * it also reports how much work is waiting, so a deploy can be held until the
 * queue is drained and a stuck queue is visible.
 */
export async function GET(): Promise<Response> {
  try {
    await pingDatabase(getDatabase());
  } catch {
    return Response.json({ ready: false, reason: "database" }, { status: 503 });
  }

  const queue = getQueueRuntime();
  if (!queue) return Response.json({ ready: true, mode: "single-process" });

  try {
    const counts = await queue.executor.queue.getJobCounts("waiting", "active", "delayed", "failed");
    return Response.json({ ready: true, mode: "queued", jobs: counts });
  } catch {
    return Response.json({ ready: false, reason: "redis" }, { status: 503 });
  }
}
