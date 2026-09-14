"use client";

import type { MemoryDto } from "@aiw/shared";
import { BrainIcon, Loader2Icon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, errorMessage } from "@/lib/api-client";

interface MemoryListProps {
  memories: MemoryDto[];
  /** Set to allow adding new memories in this scope. */
  target?: { scope: "project" | "agent" | "conversation"; projectId?: string; agentId?: string; conversationId?: string };
  emptyText?: string;
  onChange?: (memories: MemoryDto[]) => void;
}

/** Structured memory you can inspect and edit (spec §25). */
export function MemoryList({ memories, target, emptyText = "Nothing remembered yet.", onChange }: MemoryListProps) {
  const [items, setItems] = useState(memories);
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const update = (next: MemoryDto[]) => {
    setItems(next);
    onChange?.(next);
  };

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    setSaving(true);
    try {
      const memory = await apiFetch<MemoryDto>("/api/memory", { method: "POST", body: JSON.stringify({ ...target, key, value }) });
      update([...items.filter((m) => m.id !== memory.id && !(m.key === memory.key && m.scope === memory.scope)), memory].sort((a, b) => a.key.localeCompare(b.key)));
      setKey("");
      setValue("");
      setAdding(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function save(memory: MemoryDto) {
    try {
      const updated = await apiFetch<MemoryDto>(`/api/memory/${memory.id}`, { method: "PATCH", body: JSON.stringify({ value: editValue }) });
      update(items.map((m) => (m.id === memory.id ? updated : m)));
      setEditing(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove(memory: MemoryDto) {
    const previous = items;
    update(items.filter((m) => m.id !== memory.id));
    try {
      await apiFetch(`/api/memory/${memory.id}`, { method: "DELETE" });
    } catch (e) {
      update(previous);
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="grid gap-3">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="grid grid-cols-1 divide-y rounded-lg border">
          {items.map((memory) => (
            <li key={memory.id} className="grid gap-1 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium break-all">{memory.key}</span>
                <Badge variant="outline" className="text-[0.6rem]">
                  {memory.scopeName ?? memory.scope}
                </Badge>
                {memory.source === "agent" && (
                  <Badge variant="secondary" className="text-[0.6rem]">
                    remembered by the agent
                  </Badge>
                )}
                <span className="ml-auto flex gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Edit ${memory.key}`}
                    onClick={() => {
                      setEditing(memory.id);
                      setEditValue(memory.value);
                    }}
                  >
                    <PencilIcon />
                  </Button>
                  <Button variant="ghost" size="icon-xs" aria-label={`Forget ${memory.key}`} onClick={() => void remove(memory)}>
                    <Trash2Icon />
                  </Button>
                </span>
              </div>
              {editing === memory.id ? (
                <div className="flex flex-wrap gap-2">
                  <Textarea value={editValue} onChange={(e) => setEditValue(e.target.value)} rows={2} maxLength={2000} className="min-w-0 flex-1" />
                  <Button size="sm" onClick={() => void save(memory)}>
                    Save
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">{memory.value}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {target &&
        (adding ? (
          <form method="post" onSubmit={add} className="grid gap-2 rounded-lg border p-3">
            <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key, e.g. database" maxLength={80} required autoFocus className="font-mono text-xs" />
            <Textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value, e.g. PostgreSQL 17" rows={2} maxLength={2000} required />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={saving}>
                {saving && <Loader2Icon className="animate-spin" />} Remember
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setAdding(true)}>
            <PlusIcon /> <BrainIcon /> Remember something
          </Button>
        ))}
    </div>
  );
}
