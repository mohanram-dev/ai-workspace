import {
  ActivityIcon,
  BotIcon,
  CalendarClockIcon,
  FolderKanbanIcon,
  FolderOpenIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  PlugIcon,
  SettingsIcon,
  SquarePenIcon,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Build phase that delivers this section; undefined when available now. */
  phase?: number;
}

/**
 * The rows always visible in the sidebar: what a session starts from and what
 * it produces.
 *
 * Settings is deliberately absent — account and server configuration lives in
 * the user menu at the bottom of the sidebar. Listing it in both put two
 * "Settings" links on one screen.
 */
export const PRIMARY_NAV: NavItem[] = [
  { href: "/", label: "New Task", icon: SquarePenIcon },
  { href: "/conversations", label: "Conversations", icon: MessagesSquareIcon },
  { href: "/agents", label: "Agents", icon: BotIcon },
  { href: "/projects", label: "Projects", icon: FolderKanbanIcon },
  { href: "/tasks", label: "Tasks", icon: ListChecksIcon },
];

/**
 * Destinations behind the sidebar's "More" row: set up once, then visited
 * occasionally, so they do not need to cost a row each. Must stay disjoint
 * from `PRIMARY_NAV` — an entry in both would show twice at once, since the
 * flyout opens beside the list it came from.
 */
export const MORE_NAV: NavItem[] = [
  { href: "/schedules", label: "Schedules", icon: CalendarClockIcon },
  { href: "/files", label: "Files", icon: FolderOpenIcon },
  { href: "/mcp", label: "MCP Tools", icon: PlugIcon },
  { href: "/activity", label: "Activity", icon: ActivityIcon },
];

export const MOBILE_NAV: NavItem[] = [
  { href: "/", label: "Chat", icon: MessagesSquareIcon },
  { href: "/tasks", label: "Tasks", icon: ListChecksIcon },
  { href: "/agents", label: "Agents", icon: BotIcon },
  { href: "/activity", label: "Activity", icon: ActivityIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

/**
 * `includeConversations` treats open conversations as part of "/" (the mobile
 * Chat tab); the desktop sidebar highlights the conversation itself instead.
 */
export function isNavActive(pathname: string, href: string, includeConversations = false): boolean {
  if (href === "/") return pathname === "/" || (includeConversations && pathname.startsWith("/c/"));
  return pathname === href || pathname.startsWith(`${href}/`);
}
