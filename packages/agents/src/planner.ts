import type { PlanningMode } from "@aiw/shared";
import { z } from "zod";
import { buildPlannerPrompt } from "./prompts";
import type { ModelCall } from "./router";
import { parseStructured } from "./structured";

export interface PlannedStep {
  title: string;
  instruction: string;
}

export const SINGLE_STEP: PlannedStep = {
  title: "Complete the task",
  instruction: "Complete the task as requested.",
};

export const SYNTHESIS_STEP: PlannedStep = {
  title: "Compose final response",
  instruction: "Combine the completed work into the final response for the user.",
};

/** Titles that indicate the plan already ends by producing the final deliverable. */
const FINAL_STEP_TITLE = /\b(final|compose|summari[sz]e|summary|deliver|present|write[- ]?up)\b/i;

const stepSchema = z.object({
  title: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(4000),
});

/**
 * Produces the steps to execute. The last step always writes the final
 * response: a synthesis step is appended unless the plan already ends with one.
 */
export async function planTask(
  input: { prompt: string; system: string; planningMode: PlanningMode; maxSteps: number; toolNames?: string[] },
  callModel: ModelCall,
): Promise<{ steps: PlannedStep[]; planned: boolean }> {
  if (input.planningMode === "never" || input.maxSteps <= 1) {
    return { steps: [SINGLE_STEP], planned: false };
  }

  const response = await callModel({
    system: input.system,
    messages: [
      {
        role: "user",
        content: buildPlannerPrompt({
          prompt: input.prompt,
          maxSteps: input.maxSteps,
          mode: input.planningMode,
          ...(input.toolNames ? { toolNames: input.toolNames } : {}),
        }),
      },
    ],
    temperature: 0.2,
    maxOutputTokens: 2048,
    responseFormat: {
      type: "json",
      schema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            minItems: 1,
            maxItems: input.maxSteps,
            items: {
              type: "object",
              properties: { title: { type: "string" }, instruction: { type: "string" } },
              required: ["title", "instruction"],
            },
          },
        },
        required: ["steps"],
      },
    },
  });

  const parsed = parseStructured(response.text, z.object({ steps: z.array(stepSchema).min(1) }));
  if (!parsed) return { steps: [SINGLE_STEP], planned: false };

  // Models occasionally exceed the limit despite the schema.
  const steps = parsed.steps.slice(0, input.maxSteps);
  if (steps.length === 1) return { steps, planned: true };
  const endsWithFinal = FINAL_STEP_TITLE.test(steps.at(-1)!.title);
  return { steps: endsWithFinal ? steps : [...steps, SYNTHESIS_STEP], planned: true };
}
