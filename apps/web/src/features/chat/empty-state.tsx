"use client";

import { CodeIcon, FileTextIcon, LightbulbIcon, ServerIcon } from "lucide-react";
import { LogoMark } from "@/components/brand/logo";

const SUGGESTIONS = [
  {
    icon: LightbulbIcon,
    title: "Plan a project",
    prompt: "Help me plan the architecture for a multi-tenant SaaS built with Next.js and PostgreSQL. List the key decisions and trade-offs.",
  },
  {
    icon: CodeIcon,
    title: "Debug code",
    prompt: "Explain this TypeScript error and how to fix it:\n\nType 'string | undefined' is not assignable to type 'string'.",
  },
  {
    icon: ServerIcon,
    title: "Troubleshoot a server",
    prompt: "Docker is using too much disk space on my Linux server. Walk me through diagnosing and safely cleaning it up.",
  },
  {
    icon: FileTextIcon,
    title: "Draft a document",
    prompt: "Draft a concise Markdown README template for an internal developer tool, with sections for setup, usage and troubleshooting.",
  },
];

export function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-10 sm:px-6">
      <div className="mb-8 flex flex-col items-center text-center">
        <LogoMark className="mb-4 size-11 rounded-xl [&_svg]:size-6" />
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">What should we work on?</h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Describe a task and an agent will plan it and work through it. Agents reason and write only for now; tools and live execution arrive in later phases.
        </p>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {SUGGESTIONS.map(({ icon: Icon, title, prompt }) => (
          <button
            key={title}
            type="button"
            onClick={() => onPick(prompt)}
            className="group flex items-start gap-3 rounded-xl border bg-card p-3.5 text-left transition-colors hover:border-ring/40 hover:bg-muted/40"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-brand/10 group-hover:text-brand">
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{title}</span>
              <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-muted-foreground">{prompt}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
