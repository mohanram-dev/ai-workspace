import { encodeSseFrame, sendChatMessageSchema } from "@aiw/shared";
import { executeChatTurn, prepareChatTurn } from "@/server/chat/chat-service";
import { getChatRateLimiter, getChatServiceDeps } from "@/server/chat/deps";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/server/http";
import { requireApiSession } from "@/server/session";

/**
 * POST /api/chat — sends a message (or retries the last reply) and streams
 * the assistant response as Server-Sent Events.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);

    const limit = getChatRateLimiter().check(user.id);
    if (!limit.allowed) {
      throw new HttpError(429, "rate_limited", "Too many messages. Please wait a moment.", undefined, {
        "Retry-After": String(limit.retryAfterSeconds),
      });
    }

    const input = await readJson(request, sendChatMessageSchema);
    const deps = getChatServiceDeps();
    const turn = await prepareChatTurn(deps, user.id, input);

    const abort = new AbortController();
    request.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const encoder = new TextEncoder();
    let closed = false;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(encodeSseFrame(data)));
          } catch {
            closed = true;
          }
        };

        // Not awaited: generation continues independently of the reader so the
        // outcome is always persisted, even if the client disconnects.
        void (async () => {
          try {
            for await (const event of executeChatTurn(deps, turn, abort.signal)) send(event);
          } catch (error) {
            console.error("Chat turn crashed", error);
            send({ type: "error", code: "internal_error", message: "The response failed unexpectedly.", retryable: true });
          } finally {
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // Stream already cancelled by the client.
              }
            }
          }
        })();
      },
      cancel() {
        closed = true;
        abort.abort();
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
