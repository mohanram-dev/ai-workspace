import { countApiTokensForUser, createApiToken, getDatabase, listApiTokensForUser, writeAuditLog } from "@aiw/database";
import { createApiTokenSchema, MAX_API_TOKENS_PER_USER, type CreatedApiTokenDto } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/server/http";
import { generateApiToken, toApiTokenDto } from "@/server/api-tokens";
import { requireApiSession } from "@/server/session";

/** GET /api/tokens — the user's API tokens (never the tokens themselves). Session only. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const tokens = await listApiTokensForUser(getDatabase(), user.id);
    return Response.json({ tokens: tokens.map(toApiTokenDto) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/tokens — create a token. The response is the only time it is shown. Session only: a token cannot mint tokens. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const { name } = await readJson(request, createApiTokenSchema);
    const db = getDatabase();
    if ((await countApiTokensForUser(db, user.id)) >= MAX_API_TOKENS_PER_USER) {
      throw new HttpError(409, "conflict", `You already have ${MAX_API_TOKENS_PER_USER} API tokens. Delete one you no longer use.`);
    }
    const generated = generateApiToken();
    const row = await createApiToken(db, { userId: user.id, name, tokenHash: generated.hash, prefix: generated.prefix });
    await writeAuditLog(db, { userId: user.id, action: "api_token.created", resourceType: "api_token", resourceId: row.id, metadata: { name, prefix: row.prefix } });
    const body: CreatedApiTokenDto = { ...toApiTokenDto(row), token: generated.token };
    return Response.json(body, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
