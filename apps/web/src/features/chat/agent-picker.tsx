"use client";

import type { AgentDto } from "@aiw/shared";
import { BotIcon, MessageSquareIcon, WandSparklesIcon } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";

/** "auto" = router picks an agent, "chat" = direct streaming chat, otherwise an agent id. */
export type AgentMode = "auto" | "chat" | (string & {});

interface AgentPickerProps {
  agents: AgentDto[];
  value: AgentMode;
  onChange: (value: AgentMode) => void;
  disabled?: boolean;
}

export function AgentPicker({ agents, value, onChange, disabled }: AgentPickerProps) {
  const enabled = agents.filter((a) => a.enabled);
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        size="sm"
        aria-label="Agent"
        className="h-8 max-w-[9rem] gap-1.5 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted hover:text-foreground sm:max-w-[14rem] dark:bg-transparent dark:hover:bg-muted"
      >
        {value === "chat" ? (
          <MessageSquareIcon className="size-3.5 shrink-0" />
        ) : value === "auto" ? (
          <WandSparklesIcon className="size-3.5 shrink-0" />
        ) : (
          <BotIcon className="size-3.5 shrink-0" />
        )}
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="max-h-96">
        <SelectItem value="auto">Auto-route</SelectItem>
        <SelectItem value="chat">Direct chat</SelectItem>
        {enabled.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Agents</SelectLabel>
              {enabled.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}
