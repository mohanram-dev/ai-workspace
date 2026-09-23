import { describe, expect, it } from "vitest";
import { createTemplateSchema, fillTemplate, templateVariables, updateTemplateSchema } from "../src";

describe("template placeholders", () => {
  it("lists each {{name}} once, in order, ignoring spacing", () => {
    expect(templateVariables("Review {{ repo }} for {{issue}}, then report on {{repo}}.")).toEqual(["repo", "issue"]);
    expect(templateVariables("No placeholders here, just {braces} and {{}}")).toEqual([]);
  });

  it("does not treat a placeholder spread over lines as one", () => {
    expect(templateVariables("{{first\nsecond}}")).toEqual([]);
  });

  it("fills every occurrence and leaves unknown names as written", () => {
    expect(fillTemplate("Deploy {{service}} to {{ env }}; tell {{owner}} about {{service}}.", { service: "api", env: "staging" })).toBe(
      "Deploy api to staging; tell {{owner}} about api.",
    );
  });

  it("inserts a value literally, even one that looks like a replacement pattern", () => {
    expect(fillTemplate("Price: {{amount}}", { amount: "$& and $1" })).toBe("Price: $& and $1");
  });
});

describe("template schemas", () => {
  it("requires a name and a prompt, and trims them", () => {
    expect(createTemplateSchema.parse({ name: "  Weekly report ", prompt: " Summarise {{team}} " })).toMatchObject({ name: "Weekly report", prompt: "Summarise {{team}}" });
    expect(createTemplateSchema.safeParse({ name: "", prompt: "x" }).success).toBe(false);
  });

  it("refuses an empty update", () => {
    expect(updateTemplateSchema.safeParse({}).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ agentId: null }).success).toBe(true);
  });
});
