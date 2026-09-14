"use client";

import { PanelLeftCloseIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarConversationList } from "@/features/conversations/sidebar-conversation-list";
import { cn } from "@/lib/utils";
import { isNavActive, PRIMARY_NAV } from "./nav-config";
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
      </nav>

      <div className="mx-3 mb-2 border-t border-sidebar-border" />
      <SidebarConversationList onNavigate={onNavigate} />

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <UserMenu user={user} />
      </div>
    </div>
  );
}
