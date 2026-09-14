import type { ChatRequest, CompletedResponse } from "@aiw/ai";
import type { Agent } from "@aiw/database";
import type { TaskRouting } from "@aiw/shared";
import { z } from "zod";
import { DEFAULT_AGENT_SLUG } from "./builtin";
import { buildRouterPrompt } from "./prompts";
import { parseStructured } from "./structured";

export type RouterCandidate = Pick<Agent, "id" | "slug" | "name" | "description">;

export interface RoutingDecision<T extends RouterCandidate = RouterCandidate> {
  agent: T;
  routing: TaskRouting;
}

/** Calls the model; injected so routing is testable and usage can be recorded. */
export type ModelCall = (request: Omit<ChatRequest, "model" | "signal">) => Promise<CompletedResponse>;

/**
 * Chooses an agent for a task. Uses structured model output and falls back to
 * the general agent (or the first candidate) when the model's answer is unusable.
 */
export async function routeTask<T extends RouterCandidate>(
  prompt: string,
  candidates: T[],
  callModel: ModelCall,
): Promise<RoutingDecision<T>> {
  if (candidates.length === 0) throw new Error("routeTask requires at least one candidate");

  const fallbackAgent = candidates.find((a) => a.slug === DEFAULT_AGENT_SLUG) ?? candidates[0]!;
  if (candidates.length === 1) {
    return {
      agent: fallbackAgent,
      routing: { mode: "auto", method: "single", reason: "Only one agent is available for routing.", confidence: null },
    };
  }

  const slugs = candidates.map((a) => a.slug) as [string, ...string[]];
  const schema = z.object({
    agent: z.enum(slugs),
    reason: z.string().trim().min(1).max(500),
    confidence: z.number().min(0).max(1),
  });

  const { system, user } = buildRouterPrompt(candidates, prompt);
  const response = await callModel({
    system,
    messages: [{ role: "user", content: user }],
    temperature: 0,
    maxOutputTokens: 512,
    responseFormat: {
      type: "json",
      schema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: slugs },
          reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["agent", "reason", "confidence"],
      },
    },
  });

  const decision = parseStructured(response.text, schema);
  if (!decision) {
    return {
      agent: fallbackAgent,
      routing: {
        mode: "auto",
        method: "fallback",
        reason: `The router's answer could not be used, so ${fallbackAgent.name} was chosen.`,
        confidence: null,
      },
    };
  }

  return {
    agent: candidates.find((a) => a.slug === decision.agent)!,
    routing: { mode: "auto", method: "llm", reason: decision.reason, confidence: decision.confidence },
  };
}
