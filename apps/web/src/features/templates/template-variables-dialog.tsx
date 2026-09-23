"use client";

import { fillTemplate, type TemplateDto } from "@aiw/shared";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Asks for each `{{name}}` in a template, then hands back the filled-in prompt. */
export function TemplateVariablesDialog({
  template,
  onClose,
  onFilled,
}: {
  template: TemplateDto | null;
  onClose: () => void;
  onFilled: (template: TemplateDto, prompt: string) => void;
}) {
  return (
    <Dialog open={template !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {/* Keyed by template, so each one starts with empty fields. */}
        {template && <VariablesForm key={template.id} template={template} onCancel={onClose} onFilled={onFilled} />}
      </DialogContent>
    </Dialog>
  );
}

function VariablesForm({ template, onCancel, onFilled }: { template: TemplateDto; onCancel: () => void; onFilled: (template: TemplateDto, prompt: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onFilled(template, fillTemplate(template.prompt, values));
  }

  return (
    <form method="post" onSubmit={onSubmit}>
      <DialogHeader>
        <DialogTitle>{template.name}</DialogTitle>
        <DialogDescription>Fill in the blanks. Anything left empty stays as written, so you can finish it in the composer.</DialogDescription>
      </DialogHeader>
      <div className="my-4 grid gap-3">
        {template.variables.map((name, index) => (
          <div key={name} className="grid gap-1.5">
            <Label htmlFor={`template-var-${index}`}>{name}</Label>
            <Input
              id={`template-var-${index}`}
              value={values[name] ?? ""}
              onChange={(e) => setValues((current) => ({ ...current, [name]: e.target.value }))}
              autoFocus={index === 0}
            />
          </div>
        ))}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Use template</Button>
      </DialogFooter>
    </form>
  );
}
