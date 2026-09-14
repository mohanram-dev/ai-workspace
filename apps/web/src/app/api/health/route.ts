import { getDatabase, pingDatabase } from "@aiw/database";
import { getQueueRuntime } from "@aiw/runtime";

/**
 * GET /api/health — liveness plus each dependency (spec §44). Public, so it
 * reports whether a dependency answers, never why it did not.
 */
export async function GET(): Promise<Response> {
  const [database, queue] = await Promise.all([checkDatabase(), checkQueue()]);
  const ok = database === "ok" && queue !== "unreachable";
  return Response.json({ status: ok ? "ok" : "degraded", database, queue }, { status: ok ? 200 : 503 });
}

async function checkDatabase(): Promise<"ok" | "unreachable"> {
  try {
    await pingDatabase(getDatabase());
    return "ok";
  } catch {
    return "unreachable";
  }
}

/** "disabled" is a healthy answer: without REDIS_URL the app runs in one process by design. */
async function checkQueue(): Promise<"ok" | "disabled" | "unreachable"> {
  const queue = getQueueRuntime();
  if (!queue) return "disabled";
  try {
    await queue.commands.ping();
    return "ok";
  } catch {
    return "unreachable";
  }
}
