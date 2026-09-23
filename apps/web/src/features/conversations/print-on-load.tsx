"use client";

import { PrinterIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/** Opens the print dialog once the page has rendered; the button reopens it. */
export function PrintOnLoad() {
  useEffect(() => {
    // After layout and fonts, so the first page is not printed half-styled.
    const timer = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-sm print:hidden">
      <p className="min-w-0 flex-1 text-muted-foreground">Choose “Save as PDF” as the printer to keep a PDF copy.</p>
      <Button size="sm" variant="outline" onClick={() => window.print()}>
        <PrinterIcon /> Print again
      </Button>
    </div>
  );
}
