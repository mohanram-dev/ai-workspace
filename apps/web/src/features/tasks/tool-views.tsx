"use client";

import type { TaskEvent, TaskEventOf, ToolCallDto } from "@aiw/shared";
import {
  BanIcon,
  CheckIcon,
  CopyIcon,
  FileIcon,
  FilePenIcon,
  FilePlusIcon,
  Loader2Icon,
  Maximize2Icon,
  Minimize2Icon,
  ShieldXIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useCopy } from "../chat/use-copy";

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export type TerminalChunks = Record<string, { stream: "stdout" | "stderr"; text: string }[]>;

function ToolStatusIcon({ status }: { status: ToolCallDto["status"] }) {
  const common = "size-4 shrink-0";
  switch (status) {
    case "running":
      return <Loader2Icon className={cn(common, "animate-spin text-brand")} aria-label="Running" />;
    case "completed":
      return <CheckIcon className={cn(common, "text-success")} aria-label="Completed" />;
    case "denied":
      return <ShieldXIcon className={cn(common, "text-warning")} aria-label="Denied" />;
    case "cancelled":
      return <BanIcon className={cn(common, "text-muted-foreground")} aria-label="Cancelled" />;
    default:
      return <XIcon className={cn(common, "text-destructive")} aria-label="Failed" />;
  }
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="scrollbar-thin max-h-72 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[0.7rem] leading-5 whitespace-pre-wrap break-words">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** Every tool call with status, permission and inspectable input/output (spec §9). */
export function ToolCallsList({ toolCalls }: { toolCalls: ToolCallDto[] }) {
  if (toolCalls.length === 0) return <p className="text-sm text-muted-foreground">No tool calls.</p>;
  return (
    <ol className="grid grid-cols-1 gap-1">
      {toolCalls.map((call) => (
        <li key={call.id} className="min-w-0">
          <details className="group rounded-lg border [&[open]]:bg-muted/20">
            <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2 [&::-webkit-details-marker]:hidden">
              <ToolStatusIcon status={call.status} />
              <span className="font-mono text-xs font-medium">{call.toolName}</span>
              {call.category === "mcp" && (
                <Badge variant="secondary" className="text-[0.6rem]">
                  MCP
                </Badge>
              )}
              <span className={cn("min-w-0 flex-1 truncate text-xs", call.error ? "text-destructive" : "text-muted-foreground")}>
                {call.error ?? call.summary ?? (call.status === "running" ? "Running…" : "")}
              </span>
              {call.permission && (
                <Badge variant="outline" className={cn("hidden font-mono text-[0.6rem] sm:inline-flex", call.permission === "DESTRUCTIVE" && "text-destructive")}>
                  {call.permission}
                </Badge>
              )}
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDuration(call.durationMs)}</span>
            </summary>
            <div className="grid grid-cols-1 gap-2 border-t px-3 py-3 text-xs">
              <p className="text-muted-foreground">
                {timeFormatter.format(new Date(call.createdAt))} · status {call.status}
                {call.errorCode ? ` · ${call.errorCode}` : ""}
              </p>
              <div>
                <p className="mb-1 font-medium">Arguments</p>
                <Json value={call.input} />
              </div>
              {call.output !== null && call.output !== undefined && (
                <div>
                  <p className="mb-1 font-medium">Result</p>
                  <Json value={call.output} />
                </div>
              )}
            </div>
          </details>
        </li>
      ))}
    </ol>
  );
}

interface TerminalOutput {
  command?: string;
  cwd?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
}

function commandOf(call: ToolCallDto): string {
  const input = call.input as { program?: string; args?: string[] } | null;
  if (!input?.program) return call.toolName;
  return [input.program, ...(input.args ?? []).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ");
}

/** Live terminal panes for terminal.run calls: command, cwd, streamed output, exit code, duration (spec §8). */
export function TerminalView({ toolCalls, live }: { toolCalls: ToolCallDto[]; live: TerminalChunks }) {
  const commands = toolCalls.filter((c) => c.toolName === "terminal.run");
  if (commands.length === 0) return <p className="text-sm text-muted-foreground">No terminal commands.</p>;
  return (
    <div className="grid grid-cols-1 gap-4">
      {commands.map((call) => (
        <TerminalPane key={call.id} call={call} chunks={live[call.id] ?? []} />
      ))}
    </div>
  );
}

function TerminalPane({ call, chunks }: { call: ToolCallDto; chunks: { stream: "stdout" | "stderr"; text: string }[] }) {
  const [expanded, setExpanded] = useState(false);
  const { copied, copy } = useCopy();
  const ref = useRef<HTMLPreElement>(null);
  const output = (call.output ?? {}) as TerminalOutput;
  const command = output.command ?? commandOf(call);
  // Final output once recorded; streamed chunks while running.
  const segments = call.status === "running" || !call.output
    ? chunks
    : [
        ...(output.stdout ? [{ stream: "stdout" as const, text: output.stdout }] : []),
        ...(output.stderr ? [{ stream: "stderr" as const, text: output.stderr }] : []),
      ];
  const plain = segments.map((s) => s.text).join("");

  useEffect(() => {
    const el = ref.current;
    if (el && call.status === "running") el.scrollTop = el.scrollHeight;
  }, [plain, call.status]);

  const statusLabel =
    call.status === "running"
      ? "running"
      : call.status === "denied"
        ? "blocked"
        : output.timedOut
          ? "timed out"
          : output.exitCode !== undefined
            ? `exit ${output.exitCode}`
            : call.status;

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 text-neutral-100">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-800 px-3 py-2 text-xs">
        <code className="min-w-0 flex-1 truncate font-mono text-neutral-100">$ {command}</code>
        <span className="text-neutral-400">cwd {output.cwd ?? ((call.input as { cwd?: string } | null)?.cwd ?? ".")}</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono",
            call.status === "running" && "bg-brand/30 text-white",
            output.exitCode === 0 && call.status === "completed" && "bg-emerald-500/20 text-emerald-300",
            (call.status === "failed" || (output.exitCode !== undefined && output.exitCode !== 0) || output.timedOut) && "bg-red-500/20 text-red-300",
            call.status === "denied" && "bg-amber-500/20 text-amber-300",
          )}
        >
          {statusLabel}
        </span>
        <span className="text-neutral-400 tabular-nums">{formatDuration(call.durationMs)}</span>
        <span className="flex gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-neutral-300 hover:bg-neutral-800 hover:text-white"
            onClick={() => copy(`$ ${command}\n${plain}`)}
            aria-label="Copy terminal output"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-neutral-300 hover:bg-neutral-800 hover:text-white"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse output" : "Expand output"}
          >
            {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
          </Button>
        </span>
      </header>
      <pre
        ref={ref}
        className={cn("scrollbar-thin overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words", expanded ? "max-h-[70vh]" : "max-h-72")}
      >
        {segments.length === 0 ? (
          <span className="text-neutral-500">{call.status === "running" ? "Waiting for output…" : call.error ?? "(no output)"}</span>
        ) : (
          segments.map((segment, i) => (
            <span key={i} className={segment.stream === "stderr" ? "text-red-300" : undefined}>
              {segment.text}
            </span>
          ))
        )}
        {output.truncated && <span className="block text-neutral-500">… output truncated</span>}
      </pre>
    </section>
  );
}

const FILE_ICONS = { FILE_READ: FileIcon, FILE_CREATED: FilePlusIcon, FILE_UPDATED: FilePenIcon } as const;
const FILE_LABELS = { FILE_READ: "Read", FILE_CREATED: "Created", FILE_UPDATED: "Updated" } as const;

type FileEvent = TaskEventOf<"FILE_READ"> | TaskEventOf<"FILE_CREATED"> | TaskEventOf<"FILE_UPDATED">;

export function isFileEvent(event: TaskEvent): event is FileEvent {
  return event.type === "FILE_READ" || event.type === "FILE_CREATED" || event.type === "FILE_UPDATED";
}

/** File operations performed by the task, in order (spec §24). */
export function FilesView({ events }: { events: TaskEvent[] }) {
  const files = events.filter(isFileEvent);
  if (files.length === 0) return <p className="text-sm text-muted-foreground">No file operations.</p>;
  return (
    <ol className="grid grid-cols-1 divide-y rounded-lg border">
      {files.map((event) => {
        const Icon = FILE_ICONS[event.type];
        return (
          <li key={event.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Icon className={cn("size-4 shrink-0", event.type === "FILE_READ" ? "text-muted-foreground" : "text-brand")} />
            <span className="w-16 shrink-0 text-xs text-muted-foreground">{FILE_LABELS[event.type]}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{event.data.path}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{event.data.bytes.toLocaleString()} B</span>
            <time className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline" dateTime={event.timestamp}>
              {timeFormatter.format(new Date(event.timestamp))}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
