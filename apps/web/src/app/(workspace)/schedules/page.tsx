import type { Metadata } from "next";
import { SchedulesPage } from "@/features/schedules/schedules-page";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "Schedules" };

export default async function Page() {
  await requirePageSession();
  return <SchedulesPage />;
}
