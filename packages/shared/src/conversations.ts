import { z } from "zod";
import type { MessageDto } from "./chat";

export const MAX_TITLE_LENGTH = 200;

export const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    /** Move to a project, or null to detach. */
    projectId: z.uuid().nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided" });

export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

export const listConversationsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  archived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export interface ConversationDto {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  projectId: string | null;
  lastMessageAt: string;
  createdAt: string;
}

export interface ConversationWithMessagesDto extends ConversationDto {
  messages: MessageDto[];
}
