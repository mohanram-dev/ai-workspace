import type { ChatRequest, CompletedResponse } from "@aiw/ai";
import { describe, expect, it } from "vitest";
import { planTask, routeTask, SINGLE_STEP, SYNTHESIS_STEP } from "../src";

const candidates = [
  { id: "a1", slug: "general", name: "General Agent", description: "Anything" },
  { id: "a2", slug: "devops", name: "DevOps Agent", description: "Docker and servers" },
  { id: "a3", slug: "coding", name: "Coding Agent", description: "Code" },
];

function reply(text: string, seen?: ChatRequest[]) {
  return async (request: Omit<ChatRequest, "model" | "signal">): Promise<CompletedResponse> => {
    seen?.push(request as ChatRequest);
    return { text, toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  };
}

describe("routeTask", () => {
  it("uses the model's structured choice", async () => {
    const seen: ChatRequest[] = [];
    const decision = await routeTask(
      "Docker is using too much disk",
      candidates,
      reply(JSON.stringify({ agent: "devops", reason: "Docker disk usage is an infrastructure task.", confidence: 0.92 }), seen),
    );
    expect(decision.agent.slug).toBe("devops");
    expect(decision.routing).toEqual({
      mode: "auto",
      method: "llm",
      reason: "Docker disk usage is an infrastructure task.",
      confidence: 0.92,
    });
    const schema = seen[0]?.responseFormat?.schema as { properties: { agent: { enum: string[] } } };
    expect(schema.properties.agent.enum).toEqual(["general", "devops", "coding"]);
    expect(seen[0]?.messages[0]?.content).toContain("Docker is using too much disk");
  });

  it.each([
    ["invalid JSON", "not json"],
    ["an unknown agent", JSON.stringify({ agent: "hacker", reason: "x", confidence: 1 })],
    ["out-of-range confidence", JSON.stringify({ agent: "coding", reason: "x", confidence: 7 })],
  ])("falls back to the general agent on %s", async (_label, text) => {
    const decision = await routeTask("task", candidates, reply(text));
    expect(decision.agent.slug).toBe("general");
    expect(decision.routing.method).toBe("fallback");
  });

  it("skips the model when only one agent is available", async () => {
    const seen: ChatRequest[] = [];
    const decision = await routeTask("task", [candidates[1]!], reply("{}", seen));
    expect(decision.agent.slug).toBe("devops");
    expect(decision.routing.method).toBe("single");
    expect(seen).toHaveLength(0);
  });
});

describe("planTask", () => {
  const base = { prompt: "Compare frameworks", system: "sys" };

  it("returns a single step without calling the model when planning is off", async () => {
    const seen: ChatRequest[] = [];
    const plan = await planTask({ ...base, planningMode: "never", maxSteps: 5 }, reply("{}", seen));
    expect(plan).toEqual({ steps: [SINGLE_STEP], planned: false });
    expect(seen).toHaveLength(0);
  });

  it("keeps a single planned step without adding synthesis", async () => {
    const plan = await planTask(
      { ...base, planningMode: "auto", maxSteps: 5 },
      reply(JSON.stringify({ steps: [{ title: "Answer", instruction: "Answer directly." }] })),
    );
    expect(plan.steps).toEqual([{ title: "Answer", instruction: "Answer directly." }]);
  });

  it("appends a synthesis step to multi-step plans and enforces maxSteps", async () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({ title: `Step ${i + 1}`, instruction: `Do ${i + 1}` }));
    const seen: ChatRequest[] = [];
    const plan = await planTask({ ...base, planningMode: "always", maxSteps: 3 }, reply(JSON.stringify({ steps }), seen));
    expect(plan.steps.map((s) => s.title)).toEqual(["Step 1", "Step 2", "Step 3", SYNTHESIS_STEP.title]);
    expect(seen[0]?.messages[0]?.content).toContain("between 2 and 3 steps");
  });

  it("does not add a second final step when the plan already ends with one", async () => {
    const plan = await planTask(
      { ...base, planningMode: "always", maxSteps: 4 },
      reply(
        JSON.stringify({
          steps: [
            { title: "Define criteria", instruction: "List criteria." },
            { title: "Compose final report", instruction: "Write the report with a comparison table." },
          ],
        }),
      ),
    );
    expect(plan.steps.map((s) => s.title)).toEqual(["Define criteria", "Compose final report"]);
  });

  it("falls back to a single step when the plan is unusable", async () => {
    const plan = await planTask({ ...base, planningMode: "auto", maxSteps: 4 }, reply(JSON.stringify({ steps: [] })));
    expect(plan).toEqual({ steps: [SINGLE_STEP], planned: false });
  });
});
