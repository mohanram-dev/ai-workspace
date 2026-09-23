"use client";

import type { CreateTemplateInput } from "@aiw/shared";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api-client";
import { createTemplate } from "./api";

/** Saves what is in the composer, with the chosen agent, project and model, as a template. */
export function SaveTemplateDialog({ draft, onClose }: { draft: Omit<CreateTemplateInput, "name"> | null; onClose: () => void }) {
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">{draft && <SaveForm draft={draft} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

function SaveForm({ draft, onDone }: { draft: Omit<CreateTemplateInput, "name">; onDone: () => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await createTemplate({ ...draft, name });
      toast.success(`Saved “${name.trim()}”`);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form method="post" onSubmit={(e) => void onSubmit(e)}>
      <DialogHeader>
        <DialogTitle>Save as template</DialogTitle>
        <DialogDescription>
          Reuse this prompt from the Templates menu. Write <code className="font-mono text-xs">{"{{name}}"}</code> anywhere to be asked for it each time.
        </DialogDescription>
      </DialogHeader>
      <div className="my-4 grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="template-name">Name</Label>
          <Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
        </div>
        <p className="scrollbar-thin max-h-32 overflow-y-auto rounded-md border bg-muted/40 px-3 py-2 text-xs whitespace-pre-wrap text-muted-foreground">
          {draft.prompt}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !name.trim()}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
