import { ConstructionIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface NotImplementedProps {
  title: string;
  phase: number;
  description: string;
  planned: string[];
}

/** Honest placeholder for sections that are not built yet. Nothing here is simulated. */
export function NotImplemented({ title, phase, description, planned }: NotImplementedProps) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col px-4 py-10 sm:px-6 sm:py-16">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl border bg-muted/50">
          <ConstructionIcon className="size-5 text-muted-foreground" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-warning/40 bg-warning/10 font-mono text-[0.7rem] tracking-wide text-foreground">
              NOT IMPLEMENTED
            </Badge>
            <span className="text-xs text-muted-foreground">Planned for Phase {phase}</span>
          </div>
        </div>
      </div>

      <p className="text-sm leading-6 text-muted-foreground">{description}</p>

      <div className="mt-6 rounded-xl border bg-card p-5">
        <h2 className="mb-3 text-sm font-medium">What this section will do</h2>
        <ul className="grid gap-2 text-sm text-muted-foreground">
          {planned.map((item) => (
            <li key={item} className="flex gap-2">
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
