import { z } from "zod";
import { MAX_MESSAGE_LENGTH } from "./chat";

/** Tokens one user may hold; each is a standing key to their tasks. */
export const MAX_API_TOKENS_PER_USER = 20;
export const MAX_WEBHOOKS_PER_USER = 50;
/** Largest webhook body accepted. GitHub push payloads fit comfortably. */
export const MAX_WEBHOOK_PAYLOAD_BYTES = 256 * 1024;
/** Deliveries one webhook may start per minute; a runaway sender cannot run up a bill. */
export const WEBHOOK_RATE_LIMIT_PER_MINUTE = 10;

export const createApiTokenSchema = z.object({ name: z.string().trim().min(1).max(80) });
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;

export interface ApiTokenDto {
  id: string;
  name: string;
  /** The first characters of the token, to recognise it. The token itself is never shown again. */
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Returned once, when the token is created. */
export interface CreatedApiTokenDto extends ApiTokenDto {
  token: string;
}

const webhookFields = {
  name: z.string().trim().min(1).max(80),
  /** What the agent is asked to do. `{{event}}` becomes the sender's event name. */
  prompt: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  agentId: z.uuid().nullish(),
  projectId: z.uuid().nullish(),
  model: z.string().min(1).max(200).nullish(),
  enabled: z.boolean().optional(),
};

export const createWebhookSchema = z.object(webhookFields);
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z
  .object(webhookFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided" });
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

export interface WebhookDto {
  id: string;
  name: string;
  prompt: string;
  agent: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  model: string | null;
  enabled: boolean;
  /** Path to POST to, relative to the app's URL. */
  path: string;
  conversationId: string | null;
  lastTaskId: string | null;
  lastTriggeredAt: string | null;
  triggerCount: number;
  createdAt: string;
}

/** Returned when a webhook is created or its secret replaced: the only time the secret is shown. */
export interface WebhookWithSecretDto extends WebhookDto {
  secret: string;
}
