import { getAuth } from "@/server/auth";

// Better Auth handles sign-up, sign-in, sign-out and session endpoints,
// including its own origin checks and rate limiting.
export function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export function POST(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
