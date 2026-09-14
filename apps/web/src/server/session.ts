import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, type AuthSession } from "./auth";
import { HttpError } from "./http";

export async function getPageSession(): Promise<AuthSession | null> {
  // Read request headers first: this opts the page into dynamic rendering
  // before any runtime configuration is touched.
  const requestHeaders = await headers();
  return getAuth().api.getSession({ headers: requestHeaders });
}

/** For server components/layouts: redirects to sign-in when unauthenticated. */
export async function requirePageSession(): Promise<AuthSession> {
  const session = await getPageSession();
  if (!session) redirect("/sign-in");
  return session;
}

/** For route handlers: throws 401 when unauthenticated. */
export async function requireApiSession(request: Request): Promise<AuthSession> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) throw new HttpError(401, "unauthorized", "Sign in to continue.");
  return session;
}
