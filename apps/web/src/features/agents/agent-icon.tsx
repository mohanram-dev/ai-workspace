import {
  BotIcon,
  CodeIcon,
  FolderOpenIcon,
  GlobeIcon,
  MonitorIcon,
  SearchIcon,
  ServerIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  general: SparklesIcon,
  coding: CodeIcon,
  research: SearchIcon,
  browser: GlobeIcon,
  "computer-use": MonitorIcon,
  devops: ServerIcon,
  file: FolderOpenIcon,
};

export function AgentIcon({ slug, className }: { slug: string; className?: string }) {
  const Icon = ICONS[slug] ?? BotIcon;
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand", className)}>
      <Icon className="size-4" />
    </span>
  );
}
