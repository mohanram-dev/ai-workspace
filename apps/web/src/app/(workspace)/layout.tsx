import type { ReactNode } from "react";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { requirePageSession } from "@/server/session";

export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { user } = await requirePageSession();
  const role = typeof user.role === "string" ? user.role : "member";

  return <WorkspaceShell user={{ name: user.name, email: user.email, role }}>{children}</WorkspaceShell>;
}
