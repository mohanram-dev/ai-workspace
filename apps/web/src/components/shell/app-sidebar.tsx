"use client";

import { ChevronRightIcon, MoreHorizontalIcon, PanelLeftCloseIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarConversationList } from "@/features/conversations/sidebar-conversation-list";
import { cn } from "@/lib/utils";
import { isNavActive, MORE_NAV, PRIMARY_NAV } from "./nav-config";
import { UserMenu } from "./user-menu";
import type { ShellUser } from "./workspace-shell";

interface AppSidebarProps {
  user: ShellUser;
  onNavigate?: () => void;
  onCollapse?: () => void;
}

export function AppSidebar({ user, onNavigate, onCollapse }: AppSidebarProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center justify-between px-3">
        <Link href="/" onClick={onNavigate} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <Logo />
        </Link>
        {onCollapse && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label="Collapse sidebar" className="text-muted-foreground">
                <PanelLeftCloseIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Collapse sidebar</TooltipContent>
          </Tooltip>
        )}
      </div>

      <nav aria-label="Workspace" className="grid shrink-0 gap-px px-2 pb-3">
        {PRIMARY_NAV.map((item) => {
          const active = isNavActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                item.href === "/" && "mb-1 font-medium text-sidebar-foreground",
              )}
            >
              <Icon className={cn("size-4 shrink-0", item.href === "/" ? "text-brand" : "text-muted-foreground", active && "text-foreground")} />
              <span className="flex-1 truncate">{item.label}</span>
              {item.phase !== undefined && (
                <span
                  title={`Not implemented — planned for Phase ${item.phase}`}
                  className="rounded border border-sidebar-border px-1 font-mono text-[0.6rem] leading-4 text-muted-foreground/80"
                >
                  P{item.phase}
                </span>
              )}
            </Link>
          );
        })}

        <MoreNavMenu pathname={pathname} onNavigate={onNavigate} />
      </nav>

      <div className="mx-2 mb-2 border-t border-sidebar-border" />
      <SidebarConversationList onNavigate={onNavigate} />

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <UserMenu user={user} />
      </div>
    </div>
  );
}

/** The shell's own breakpoint: persistent sidebar above it, sheet below. */
const DESKTOP_QUERY = "(min-width: 768px)";

/**
 * Whether the persistent sidebar is showing. The flyout cannot rely on Radix's
 * collision detection to work this out: inside the mobile sheet an animated
 * ancestor carries a transform, which makes a fixed-position menu measure
 * against the wrong box, so a right-opening menu ran 176px off a 390px screen
 * instead of flipping.
 */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(DESKTOP_QUERY);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

/**
 * The sidebar's "More" row: a flyout holding the destinations that do not earn
 * a permanent row. It highlights like a nav item when the page you are on is
 * one of its entries, so the current location is never hidden inside a closed
 * menu.
 */
function MoreNavMenu({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const active = MORE_NAV.some((item) => isNavActive(pathname, item.href));
  const isDesktop = useIsDesktop();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "group flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground/80 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-sidebar-accent",
          active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
        )}
      >
        <MoreHorizontalIcon className={cn("size-4 shrink-0 text-muted-foreground", active && "text-foreground")} />
        <span className="flex-1 truncate text-left">More</span>
        <ChevronRightIcon className="size-3.5 text-muted-foreground max-md:hidden" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={isDesktop ? "right" : "bottom"}
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="min-w-44"
      >
        {MORE_NAV.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem key={item.href} asChild>
              <Link href={item.href} onClick={onNavigate} aria-current={isNavActive(pathname, item.href) ? "page" : undefined}>
                <Icon /> {item.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
