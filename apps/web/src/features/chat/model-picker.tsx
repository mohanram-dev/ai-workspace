"use client";

import type { ModelDto } from "@aiw/shared";
import { SparklesIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const DEFAULT_MODEL_VALUE = "__default__";

interface ModelPickerProps {
  models: ModelDto[];
  value: string | undefined;
  onChange: (model: string) => void;
  disabled?: boolean;
  /** Adds a first option (value DEFAULT_MODEL_VALUE), e.g. the agent default. */
  defaultLabel?: string;
}

export function ModelPicker({ models, value, onChange, disabled, defaultLabel }: ModelPickerProps) {
  return (
    <Select value={value ?? ""} onValueChange={onChange} disabled={disabled || models.length === 0}>
      <SelectTrigger
        size="sm"
        aria-label="Model"
        className="h-8 max-w-[11rem] gap-1.5 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted hover:text-foreground sm:max-w-[16rem] dark:bg-transparent dark:hover:bg-muted"
      >
        <SparklesIcon className="size-3.5 shrink-0" />
        <SelectValue placeholder="No model" />
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="max-h-80">
        {defaultLabel && (
          <SelectItem value={DEFAULT_MODEL_VALUE} className="text-sm">
            {defaultLabel}
          </SelectItem>
        )}
        {models.map((model) => (
          // Item text is also what the trigger displays, so keep it to the label.
          <SelectItem key={model.id} value={model.id} title={model.id} className="text-sm">
            {model.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
