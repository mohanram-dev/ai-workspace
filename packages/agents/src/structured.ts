import type { z } from "zod";

/**
 * Parses a model's JSON response and validates it. Returns null instead of
 * throwing so callers can fall back deterministically.
 */
export function parseStructured<T extends z.ZodType>(text: string, schema: T): z.infer<T> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}
