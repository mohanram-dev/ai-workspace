"use client";

import { Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

interface AuthFormProps {
  mode: "sign-in" | "sign-up";
  registrationOpen: boolean;
}

export function AuthForm({ mode, registrationOpen }: AuthFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isSignUp = mode === "sign-up";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    if (isSignUp && password !== String(form.get("confirmPassword") ?? "")) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    const result = isSignUp
      ? await authClient.signUp.email({ name: String(form.get("name") ?? "").trim(), email, password })
      : await authClient.signIn.email({ email, password });
    setPending(false);

    if (result.error) {
      setError(result.error.message ?? (isSignUp ? "Could not create the account." : "Invalid email or password."));
      return;
    }
    router.replace("/");
    router.refresh();
  }

  if (isSignUp && !registrationOpen) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Registration is closed</CardTitle>
          <CardDescription>
            This workspace already has an owner. Ask an administrator to enable registration
            (<code className="font-mono text-xs">ALLOW_REGISTRATION=true</code>).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full">
            <Link href="/sign-in">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{isSignUp ? "Create your workspace" : "Welcome back"}</CardTitle>
        <CardDescription>
          {isSignUp
            ? "The first account becomes the workspace administrator."
            : "Sign in to continue to your workspace."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" onSubmit={onSubmit} className="grid gap-4" noValidate={false}>
          {isSignUp && (
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" autoComplete="name" required maxLength={100} />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={isSignUp ? "new-password" : "current-password"}
              required
              minLength={isSignUp ? 10 : undefined}
              maxLength={128}
            />
            {isSignUp && <p className="text-xs text-muted-foreground">At least 10 characters.</p>}
          </div>
          {isSignUp && (
            <div className="grid gap-2">
              <Label htmlFor="confirmPassword">Confirm password</Label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                maxLength={128}
              />
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" className="w-full" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {isSignUp ? "Create account" : "Sign in"}
          </Button>
        </form>

        <p className="mt-5 text-center text-sm text-muted-foreground">
          {isSignUp ? (
            <>
              Already have an account?{" "}
              <Link href="/sign-in" className="font-medium text-foreground hover:underline">
                Sign in
              </Link>
            </>
          ) : registrationOpen ? (
            <>
              New here?{" "}
              <Link href="/sign-up" className="font-medium text-foreground hover:underline">
                Create an account
              </Link>
            </>
          ) : (
            "Registration is closed on this workspace."
          )}
        </p>
      </CardContent>
    </Card>
  );
}
