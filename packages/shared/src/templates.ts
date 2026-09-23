import { z } from "zod";
import { MAX_MESSAGE_LENGTH } from "./chat";

/** Saved prompts one user may keep. */
export const MAX_TEMPLATES_PER_USER = 200;

const templateFields = {
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  /** The agent the composer switches to; null keeps whatever is selected. */
  agentId: z.uuid().nullish(),
  projectId: z.uuid().nullish(),
  model: z.string().min(1).max(200).nullish(),
};

export const createTemplateSchema = z.object(templateFields);
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z
  .object(templateFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided" });
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

export interface TemplateDto {
  id: string;
  name: string;
  prompt: string;
  agent: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  model: string | null;
  /** The `{{name}}` placeholders, asked for when the template is used. */
  variables: string[];
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const PLACEHOLDER = /\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g;

/** The `{{name}}` placeholders in a prompt, each once, in the order they first appear. */
export function templateVariables(prompt: string): string[] {
  const names: string[] = [];
  for (const match of prompt.matchAll(PLACEHOLDER)) {
    const name = match[1]!.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Replaces every `{{name}}` with its value. A name without a value is left as written. */
export function fillTemplate(prompt: string, values: Record<string, string>): string {
  // A function replacer, so a value containing "$&" or "$1" is inserted literally.
  return prompt.replace(PLACEHOLDER, (whole, name: string) => {
    const key = name.trim();
    return Object.hasOwn(values, key) ? values[key]! : whole;
  });
}
