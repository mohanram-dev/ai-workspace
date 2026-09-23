import type { Conversation, Message, TaskStep, TaskWithAgent, ToolCall } from "@aiw/database";
import { formatCost, formatDuration, formatTokens } from "@/lib/format";

/** Rows an Activity CSV may hold, so an export of a busy year stays a download, not a crash. */
export const MAX_CSV_ROWS = 20_000;

const timestamp = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Headers for a file download: an ASCII fallback name, and the real one per RFC 6266. */
export function downloadHeaders(filename: string, contentType: string): HeadersInit {
  const ascii =
    filename
      .replace(/[^\w.-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-(?=\.)/g, "")
      .replace(/\.{2,}/g, ".") || "export";
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
  };
}

/** A file name from a title: short, and safe on every operating system. */
export function exportFilename(title: string, extension: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "export";
  return `${base}.${extension}`;
}

/** A value inside a Markdown table cell: pipes escaped, one line. */
const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

export function conversationMarkdown(
  conversation: Conversation,
  messages: Message[],
  tasks: Map<string, TaskWithAgent>,
  now = new Date(),
): string {
  const lines = [`# ${conversation.title}`, "", `Exported from AI Workspace on ${timestamp(now)} · ${messages.length} message${messages.length === 1 ? "" : "s"}`, ""];
  for (const message of messages) {
    if (message.role === "system") continue;
    const task = message.taskId ? tasks.get(message.taskId) : undefined;
    const who = message.role === "user" ? "You" : (task?.agent?.name ?? "Assistant");
    const facts = [timestamp(message.createdAt), message.model, message.role === "assistant" && message.status !== "completed" ? message.status : null].filter(Boolean);
    lines.push("---", "", `**${who}** · ${facts.join(" · ")}`, "");
    lines.push(message.content.trim() || (message.role === "assistant" ? "_(no reply)_" : ""));
    if (message.error) lines.push("", `> Error: ${message.error}`);
    const attachments = message.attachments ?? [];
    if (attachments.length > 0) lines.push("", `Attachments: ${attachments.map((a) => a.name).join(", ")}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function taskMarkdown(task: TaskWithAgent, steps: TaskStep[], toolCalls: ToolCall[], subTasks: TaskWithAgent[], now = new Date()): string {
  const firstLine = task.prompt.split("\n").find((l) => l.trim())?.trim() ?? "Task";
  const lines = [`# Task: ${firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine}`, "", `Exported from AI Workspace on ${timestamp(now)}`, ""];

  const routing = task.routing
    ? ` — ${task.routing.mode === "manual" ? "chosen by you" : `routed (${task.routing.method}${task.routing.confidence !== null ? `, ${task.routing.confidence}` : ""}): ${task.routing.reason}`}`
    : "";
  const facts: [string, string][] = [
    ["Status", task.status],
    ["Agent", `${task.agent?.name ?? "—"}${routing}`],
    ["Model", task.model ? `${task.provider} / ${task.model}` : "—"],
    ["Project", task.projectName ?? "—"],
    ["Created", timestamp(task.createdAt)],
    ["Duration", formatDuration(task.durationMs)],
    ["Tokens", `${formatTokens(task.inputTokens)} in / ${formatTokens(task.outputTokens)} out`],
    ["Estimated cost", formatCost(task.estimatedCostUsd)],
    ["Attempt", String(task.attempt)],
  ];
  lines.push("| | |", "| --- | --- |", ...facts.map(([k, v]) => `| ${k} | ${cell(v)} |`), "");

  lines.push("## Prompt", "", task.prompt.trim(), "");
  const attachments = task.attachments ?? [];
  if (attachments.length > 0) lines.push("## Attachments", "", ...attachments.map((a) => `- ${a.name} (${a.mimeType})`), "");

  if (steps.length > 0) {
    lines.push("## Plan", "", ...steps.map((s) => `${s.index + 1}. ${s.title} — ${s.status}${s.durationMs !== null ? ` (${formatDuration(s.durationMs)})` : ""}`), "");
    lines.push("## Steps", "");
    for (const step of steps) {
      lines.push(`### ${step.index + 1}. ${step.title}`, "", `_${step.instruction.trim()}_`, "");
      if (step.output?.trim()) lines.push(step.output.trim(), "");
      if (step.error) lines.push(`> Error: ${step.error}`, "");
    }
  }

  if (toolCalls.length > 0) {
    lines.push("## Tool calls", "", "| # | Tool | Status | What happened | Time |", "| --- | --- | --- | --- | --- |");
    toolCalls.forEach((call, index) => {
      const what = call.summary ?? call.error ?? "";
      lines.push(`| ${index + 1} | \`${call.toolName}\` | ${call.status} | ${cell(what)} | ${formatDuration(call.durationMs)} |`);
    });
    lines.push("");
  }

  if (subTasks.length > 0) {
    lines.push("## Delegated tasks", "");
    for (const sub of subTasks) lines.push(`- **${sub.agent?.name ?? "Agent"}** (${sub.status}): ${sub.prompt.split("\n")[0]!.slice(0, 160)}`);
    lines.push("");
  }

  if (task.result?.trim()) lines.push("## Result", "", task.result.trim(), "");
  if (task.error) {
    lines.push("## Error", "", `**${task.error.title}:** ${task.error.message}`, "");
    if (task.error.suggestedAction) lines.push(`Suggested: ${task.error.suggestedAction}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * One CSV cell (RFC 4180). A text cell that a spreadsheet would read as a
 * formula (=, +, -, @, tab, CR) is prefixed with an apostrophe: prompts and
 * answers are user and model text, and opening an export must not run it.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** A CSV document with a byte-order mark, so spreadsheet apps read it as UTF-8. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return `﻿${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
