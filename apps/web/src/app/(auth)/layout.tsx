import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-full flex-col items-center justify-center overflow-hidden px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(ellipse_at_top,color-mix(in_oklch,var(--brand)_18%,transparent),transparent_70%)]"
      />
      <Logo className="mb-8" />
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
