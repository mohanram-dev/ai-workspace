import type { Metadata } from "next";
import { AgentsPage } from "@/features/agents/agents-page";
import { getProviderRegistry } from "@/server/providers";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "Agents" };

export default async function Page() {
  await requirePageSession();
  const provider = getProviderRegistry().getDefault();
  return <AgentsPage defaultModel={provider.defaultModel} />;
}
