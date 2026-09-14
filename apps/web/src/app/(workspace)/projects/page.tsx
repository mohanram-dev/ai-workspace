import type { Metadata } from "next";
import { ProjectsPage } from "@/features/projects/projects-page";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "Projects" };

export default async function Page() {
  await requirePageSession();
  return <ProjectsPage />;
}
