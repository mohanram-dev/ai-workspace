import type { Metadata } from "next";
import { FilesPage } from "@/features/files/files-page";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "Files" };

export default async function Page() {
  await requirePageSession();
  return <FilesPage />;
}
