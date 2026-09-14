import postgres from "postgres";
import { runMigrations } from "./migrate";

export const DEFAULT_TEST_DATABASE_URL = "postgres://aiw:aiw@localhost:5432/aiw_test";

export function getTestDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

/**
 * Drops and recreates the test database schema, then applies all migrations.
 * Refuses to run against a database whose name does not end in `_test`.
 */
export async function resetTestDatabase(url = getTestDatabaseUrl()): Promise<void> {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to reset non-test database "${dbName}"`);
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`select 1`;
  } catch (error) {
    await sql.end({ timeout: 1 });
    throw new Error(
      `Cannot connect to the test database at ${new URL(url).host}. ` +
        "Start it with `docker compose up -d postgres` or set TEST_DATABASE_URL.",
      { cause: error },
    );
  }
  try {
    await sql.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  } finally {
    await sql.end({ timeout: 5 });
  }
  await runMigrations(url);
}
