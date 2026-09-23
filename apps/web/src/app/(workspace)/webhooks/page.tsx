import type { Metadata } from "next";
import { WebhooksPage } from "@/features/webhooks/webhooks-page";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "Webhooks" };

export default async function Page() {
  await requirePageSession();
  return <WebhooksPage />;
}
