import type { ModelDto } from "@aiw/shared";
import { describe, expect, it } from "vitest";
import { groupModelsByProvider } from "./model-picker";

function model(id: string, provider: string): ModelDto {
  return { id, label: id, provider, inputTokenLimit: null, outputTokenLimit: null };
}

describe("model picker grouping (spec §13)", () => {
  it("keeps the order the API sent, so the default provider stays first", () => {
    const groups = groupModelsByProvider([
      model("qwen/qwen3.7-flash", "openrouter"),
      model("openai/gpt-oss-120b", "openrouter"),
      model("gemini-3.1-flash-lite", "gemini"),
      model("gemini-3.5-flash-lite", "gemini"),
    ]);

    expect(groups.map((g) => g.provider)).toEqual(["openrouter", "gemini"]);
    expect(groups[0]!.models.map((m) => m.id)).toEqual(["qwen/qwen3.7-flash", "openai/gpt-oss-120b"]);
    expect(groups[1]!.models).toHaveLength(2);
  });

  it("does not merge a provider that appears again later", () => {
    // Runs stay separate rather than being collected: merging them would move a
    // model away from the position the server chose for it.
    const groups = groupModelsByProvider([model("a", "gemini"), model("b", "openrouter"), model("c", "gemini")]);
    expect(groups.map((g) => g.provider)).toEqual(["gemini", "openrouter", "gemini"]);
  });

  it("handles one provider and none at all", () => {
    expect(groupModelsByProvider([model("a", "gemini")])).toEqual([
      { provider: "gemini", models: [model("a", "gemini")] },
    ]);
    expect(groupModelsByProvider([])).toEqual([]);
  });
});
