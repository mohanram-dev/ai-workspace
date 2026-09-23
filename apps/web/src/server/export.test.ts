import type { Conversation, Message, TaskStep, TaskWithAgent, ToolCall } from "@aiw/database";
import { describe, expect, it } from "vitest";
import { conversationMarkdown, csvCell, downloadHeaders, exportFilename, taskMarkdown, toCsv } from "./export";

const at = new Date("2026-09-23T10:15:00Z");

describe("CSV", () => {
  it("quotes what needs quoting and doubles quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", then go')).toBe('"say ""hi"", then go"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(0.0013)).toBe("0.0013");
    expect(csvCell(Number.NaN)).toBe("");
  });

  it("defuses text a spreadsheet would run as a formula, but not numbers", () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell("+1 more")).toBe("'+1 more");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-2 days")).toBe("'-2 days");
    expect(csvCell(-2)).toBe("-2");
  });

  it("writes a byte-order mark and CRLF rows", () => {
    expect(toCsv(["a", "b"], [[1, "x"]])).toBe("﻿a,b\r\n1,x\r\n");
  });
});

describe("download names", () => {
  it("keeps a readable name and an ASCII fallback", () => {
    expect(exportFilename('Plan: Q4 "launch" / notes', "md")).toBe("Plan Q4 launch notes.md");
    const headers = downloadHeaders("Résumé review.md", "text/markdown") as Record<string, string>;
    expect(headers["Content-Disposition"]).toBe(`attachment; filename="R-sum-review.md"; filename*=UTF-8''R%C3%A9sum%C3%A9%20review.md`);
    expect(headers["Cache-Control"]).toBe("no-store");
    // A title ending in an ellipsis must not leave "..md".
    const ellipsis = downloadHeaders("LTS version.….md", "text/markdown") as Record<string, string>;
    expect(ellipsis["Content-Disposition"]).toContain('filename="LTS-version.md"');
  });
});

describe("conversation Markdown", () => {
  it("names who spoke, keeps the text, and notes attachments and errors", () => {
    const conversation = { title: "Launch plan" } as Conversation;
    const message = (values: Partial<Message>) => ({ role: "user", content: "", status: "completed", createdAt: at, attachments: null, error: null, model: null, taskId: null, ...values }) as Message;
    const task = { id: "t1", agent: { id: "a", name: "Research Agent", slug: "research" } } as TaskWithAgent;
    const md = conversationMarkdown(
      conversation,
      [
        message({ content: "Compare the options", attachments: [{ path: "p", name: "brief.pdf", mimeType: "application/pdf", size: 1 }] }),
        message({ role: "assistant", content: "Option A wins.", taskId: "t1", model: "qwen/qwen3.7-flash" }),
        message({ role: "assistant", content: "", status: "failed", error: "Rate limited" }),
      ],
      new Map([["t1", task]]),
      at,
    );
    expect(md).toContain("# Launch plan");
    expect(md).toContain("**You** · 2026-09-23 10:15 UTC\n\nCompare the options\n\nAttachments: brief.pdf");
    expect(md).toContain("**Research Agent** · 2026-09-23 10:15 UTC · qwen/qwen3.7-flash\n\nOption A wins.");
    expect(md).toContain("**Assistant** · 2026-09-23 10:15 UTC · failed\n\n_(no reply)_\n\n> Error: Rate limited");
  });
});

describe("task Markdown", () => {
  it("reports the facts, the plan, each step, the tool calls and the result", () => {
    const task = {
      prompt: "Find | compare hosting options\nfor the app",
      status: "completed",
      agent: { id: "a", name: "Research Agent", slug: "research" },
      routing: { mode: "auto", method: "llm", reason: "Research task.", confidence: 0.9 },
      provider: "openrouter",
      model: "qwen/qwen3.7-flash",
      projectName: null,
      createdAt: at,
      durationMs: 21_000,
      inputTokens: 5075,
      outputTokens: 609,
      estimatedCostUsd: 0.0013,
      attempt: 1,
      attachments: null,
      result: "Use host B.",
      error: null,
    } as unknown as TaskWithAgent;
    const steps = [{ index: 0, title: "Search", instruction: "Search the web.", status: "completed", output: "Found 3 hosts.", error: null, durationMs: 9000 }] as TaskStep[];
    const calls = [{ toolName: "web.search", status: "completed", summary: "Searched a | b", error: null, durationMs: 1200 }] as ToolCall[];

    const md = taskMarkdown(task, steps, calls, [], at);
    expect(md).toContain("# Task: Find | compare hosting options");
    expect(md).toContain("| Agent | Research Agent — routed (llm, 0.9): Research task. |");
    expect(md).toContain("| Model | openrouter / qwen/qwen3.7-flash |");
    expect(md).toContain("1. Search — completed (9.0 s)");
    expect(md).toContain("### 1. Search\n\n_Search the web._\n\nFound 3 hosts.");
    // A pipe inside a table cell must not split the row.
    expect(md).toContain("| 1 | `web.search` | completed | Searched a \\| b |");
    expect(md).toContain("## Result\n\nUse host B.");
  });
});
