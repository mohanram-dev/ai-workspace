import type { Metadata } from "next";
import { TemplatesPage } from "@/features/templates/templates-page";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "Templates" };

export default async function Page() {
  await requirePageSession();
  return <TemplatesPage />;
}
