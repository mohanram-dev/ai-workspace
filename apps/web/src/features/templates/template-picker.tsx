"use client";

import type { CreateTemplateInput, TemplateDto } from "@aiw/shared";
import { BookmarkIcon, BookmarkPlusIcon, Settings2Icon } from "lucide-react";
import Link from "next/link";
import { useEffect, useEffectEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/api-client";
import { listTemplates, markTemplateUsed } from "./api";
import { SaveTemplateDialog } from "./save-template-dialog";
import { TemplateVariablesDialog } from "./template-variables-dialog";

interface TemplatePickerProps {
  /** What is in the composer now, and what it is set to, for "Save as template". */
  current: () => Omit<CreateTemplateInput, "name">;
  /** Puts a (filled-in) template into the composer. */
  onUse: (template: TemplateDto, prompt: string) => void;
  /** A template to use straight away, from a "/?template=<id>" link. */
  useId?: string | null | undefined;
  disabled?: boolean;
}

/** Saved prompts in the composer's toolbar: pick one to fill the composer, or save what is there. */
export function TemplatePicker({ current, onUse, useId, disabled }: TemplatePickerProps) {
  const [templates, setTemplates] = useState<TemplateDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [asking, setAsking] = useState<TemplateDto | null>(null);
  const [saving, setSaving] = useState<Omit<CreateTemplateInput, "name"> | null>(null);
  // What the composer held when the menu opened: it lives in the composer, which
  // does not re-render this menu as you type.
  const [draft, setDraft] = useState<Omit<CreateTemplateInput, "name">>({ prompt: "" });

  function load() {
    setLoadError(null);
    listTemplates()
      .then(setTemplates)
      .catch((e: unknown) => setLoadError(errorMessage(e)));
  }

  function use(template: TemplateDto, prompt: string) {
    setAsking(null);
    markTemplateUsed(template.id);
    onUse(template, prompt);
  }

  const applyLinked = useEffectEvent((all: TemplateDto[]) => {
    const template = all.find((t) => t.id === useId);
    if (!template) return;
    if (template.variables.length > 0) setAsking(template);
    else use(template, template.prompt);
  });
  useEffect(() => {
    if (!useId) return;
    let active = true;
    listTemplates()
      .then((all) => {
        if (!active) return;
        setTemplates(all);
        applyLinked(all);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [useId]);

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          setDraft(current());
          load();
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Templates" disabled={disabled} className="text-muted-foreground">
            <BookmarkIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Templates</DropdownMenuLabel>
          {loadError ? (
            <p role="alert" className="px-2 py-1.5 text-xs text-destructive">
              {loadError}
            </p>
          ) : templates === null ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
          ) : templates.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No templates yet. Write a prompt, then save it here.</p>
          ) : (
            <div className="scrollbar-thin max-h-72 overflow-y-auto">
              {templates.map((template) => (
                <DropdownMenuItem
                  key={template.id}
                  onSelect={() => (template.variables.length > 0 ? setAsking(template) : use(template, template.prompt))}
                  className="flex-col items-start gap-0.5"
                >
                  <span className="w-full truncate font-medium">{template.name}</span>
                  <span className="line-clamp-1 w-full text-xs text-muted-foreground">{template.prompt}</span>
                </DropdownMenuItem>
              ))}
            </div>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!draft.prompt.trim()} onSelect={() => setSaving(draft)}>
            <BookmarkPlusIcon /> Save current text as template…
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/templates">
              <Settings2Icon /> Manage templates
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TemplateVariablesDialog template={asking} onClose={() => setAsking(null)} onFilled={use} />
      <SaveTemplateDialog draft={saving} onClose={() => setSaving(null)} />
    </>
  );
}
