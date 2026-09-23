import { createHash, randomBytes } from "node:crypto";
import { findApiTokenByHash, getDatabase, touchApiToken, type ApiToken } from "@aiw/database";
import type { ApiTokenDto } from "@aiw/shared";
import { HttpError } from "./http";
import { requireApiSession } from "./session";

const TOKEN_PREFIX = "aiw_";

/** A new token: 256 random bits. Only its hash is stored; the caller shows the token once. */
export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashApiToken(token), prefix: token.slice(0, 12) };
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The caller of a route that also accepts personal API tokens: the bearer
 * token when one is sent, the signed-in session otherwise. A browser never
 * attaches a bearer token by itself, so a token cannot be used cross-site.
 */
export async function requireApiUser(request: Request): Promise<{ user: { id: string } }> {
  const header = request.headers.get("authorization");
  if (header && /^bearer\s/i.test(header)) {
    const token = header.slice(header.indexOf(" ") + 1).trim();
    const db = getDatabase();
    const row = token.startsWith(TOKEN_PREFIX) ? await findApiTokenByHash(db, hashApiToken(token)) : null;
    if (!row) throw new HttpError(401, "unauthorized", "The API token is not valid.");
    await touchApiToken(db, row.id);
    return { user: { id: row.userId } };
  }
  const { user } = await requireApiSession(request);
  return { user };
}

export function toApiTokenDto(row: ApiToken): ApiTokenDto {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
