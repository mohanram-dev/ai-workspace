import { getDatabase, listRecentActivityEvents } from "@aiw/database";
import { toTaskEvent } from "@aiw/agents";
import { getAgentServices } from "@aiw/runtime";
import type { TaskEvent } from "@aiw/shared";
import { errorResponse } from "@/server/http";
import { requireApiSession } from "@/server/session";

const HEARTBEAT_MS = 25_000;
const SEED_COUNT = 30;

function frame(event: TaskEvent): string {
  return `id: ${event.id}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * GET /api/activity/events — every event across the signed-in user's tasks, as
 * they are recorded. The bus has a channel per user, so this never sees another
 * user's activity, and it works whether tasks run in this process or in the
 * worker tier (where the events arrive over Redis).
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const { bus } = getAgentServices();
    const encoder = new TextEncoder();

    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            closed = true;
          }
        };
        const seen = new Set<number>();

        // Subscribe before seeding, so an event recorded during the seed query
        // is queued rather than lost; ids de-duplicate the overlap.
        unsubscribe = bus.subscribeUser(user.id, (event) => {
          if (seen.has(event.id)) return;
          seen.add(event.id);
          send(frame(event));
        });

        const recent = await listRecentActivityEvents(getDatabase(), user.id, SEED_COUNT);
        for (const row of recent.reverse()) {
          const event = toTaskEvent(row);
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          send(frame(event));
        }

        heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
        request.signal.addEventListener("abort", () => {
          closed = true;
          unsubscribe?.();
          if (heartbeat) clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // Already closed by the runtime.
          }
        });
      },
      cancel() {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
