import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/features/auth/auth-form";
import { isRegistrationOpen } from "@/server/auth";
import { getPageSession } from "@/server/session";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  if (await getPageSession()) redirect("/");
  return <AuthForm mode="sign-in" registrationOpen={await isRegistrationOpen()} />;
}
