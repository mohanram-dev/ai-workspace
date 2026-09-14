"use client";

import { MenuIcon, PanelLeftOpenIcon, SquarePenIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConversationsProvider } from "@/features/conversations/conversations-context";
import { cn } from "@/lib/utils";
import { AppSidebar } from "./app-sidebar";
import { MobileBottomNav } from "./mobile-bottom-nav";

export interface ShellUser {
  name: string;
  email: string;
  role: string;
}

const COLLAPSE_KEY = "aiw:sidebar-collapsed";

export function WorkspaceShell({ user, children }: { user: ShellUser; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // Restore the persisted preference after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  function setCollapsedPersisted(value: boolean) {
    setCollapsed(value);
    window.localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0");
  }

  return (
    <ConversationsProvider>
      <div data-collapsed={collapsed} className="group/shell flex h-dvh overflow-hidden bg-background">
        {/* Desktop / tablet sidebar */}
        <aside
          className={cn(
            "hidden shrink-0 overflow-hidden border-r border-sidebar-border transition-[width] duration-200 md:block",
            collapsed ? "w-0 border-r-0" : "w-64 lg:w-72",
          )}
        >
          <div className="h-full w-64 lg:w-72">
            <AppSidebar user={user} onCollapse={() => setCollapsedPersisted(true)} />
          </div>
        </aside>

        {/* Mobile drawer */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-[85vw] max-w-80 gap-0 p-0" showCloseButton={false}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Workspace navigation and conversations</SheetDescription>
            <AppSidebar user={user} onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar */}
          <header className="flex h-12 shrink-0 items-center justify-between border-b px-2 md:hidden">
            <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
              <MenuIcon />
            </Button>
            <Link href="/" className="flex items-center gap-2 text-sm font-semibold">
              <LogoMark className="size-6" /> AI Workspace
            </Link>
            <Button variant="ghost" size="icon" asChild aria-label="New task">
              <Link href="/">
                <SquarePenIcon />
              </Link>
            </Button>
          </header>

          {collapsed && (
            <div className="absolute top-3 left-3 z-20 hidden gap-1 md:flex">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => setCollapsedPersisted(false)} aria-label="Expand sidebar">
                    <PanelLeftOpenIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Expand sidebar</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" asChild aria-label="New task">
                    <Link href="/">
                      <SquarePenIcon />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">New task</TooltipContent>
              </Tooltip>
            </div>
          )}

          <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
          <MobileBottomNav />
        </div>
      </div>
    </ConversationsProvider>
  );
}
