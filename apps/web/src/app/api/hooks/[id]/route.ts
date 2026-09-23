import { getDatabase, getWebhook, writeAuditLog } from "@aiw/database";
import { MAX_WEBHOOK_PAYLOAD_BYTES } from "@aiw/shared";
import { getAgentServices } from "@/server/agents";
import { errorResponse, HttpError, isUuid } from "@/server/http";
import { getWebhookRateLimiter, readLimitedBody, startWebhookTask, verifyWebhookDelivery, webhookPrompt, webhookSecretBox } from "@/server/webhooks";

/**
 * POST /api/hooks/:id — an inbound webhook delivery. Public: there is no
 * session, so the webhook's secret is what authorises the call — sent in
 * X-Webhook-Secret, or as GitHub's X-Hub-Signature-256. A valid delivery
 * starts a task from the webhook's prompt with the body attached as data.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/hooks/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "Webhook not found.");
    const db = getDatabase();
    const webhook = await getWebhook(db, id);
    if (!webhook || !webhook.enabled) throw new HttpError(404, "not_found", "Webhook not found.");

    const body = await readLimitedBody(request, MAX_WEBHOOK_PAYLOAD_BYTES);
    let secret: string;
    try {
      secret = webhookSecretBox().decrypt(webhook.secretEncrypted);
    } catch {
      // BETTER_AUTH_SECRET changed since the secret was stored.
      throw new HttpError(500, "internal_error", "This webhook's secret can no longer be read. Create a new secret for it.");
    }
    if (!verifyWebhookDelivery(secret, request.headers, body)) {
      throw new HttpError(401, "unauthorized", "The webhook secret or signature is missing or wrong.");
    }

    // Counted only after the secret checked out, so strangers cannot use up the sender's allowance.
    const limit = getWebhookRateLimiter().check(webhook.id);
    if (!limit.allowed) {
      throw new HttpError(429, "rate_limited", "Too many deliveries to this webhook. Slow down.", undefined, { "Retry-After": String(limit.retryAfterSeconds) });
    }

    const event = request.headers.get("x-github-event") ?? request.headers.get("x-webhook-event");
    // GitHub pings a webhook once when it is created: acknowledge it without starting a task.
    if (event === "ping") return Response.json({ ok: true });

    const started = await startWebhookTask(db, getAgentServices().tasks, webhook, webhookPrompt(webhook.prompt, body.toString("utf8"), event));
    await writeAuditLog(db, {
      userId: webhook.userId,
      action: "webhook.delivered",
      resourceType: "webhook",
      resourceId: webhook.id,
      metadata: { taskId: started.taskId, event, bytes: body.length },
    });
    return Response.json(started, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
