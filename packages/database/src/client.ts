import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

export function createDatabase(url: string, options: { max?: number } = {}): DatabaseHandle {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // Silence NOTICE output (e.g. "relation already exists, skipping").
    onnotice: () => {},
  });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

export async function pingDatabase(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}

const globalForDb = globalThis as unknown as { __aiwDb?: DatabaseHandle };

/**
 * Process-wide database handle. Cached on globalThis so Next.js dev hot
 * reloads do not open a new pool on every change.
 */
export function getDatabase(): Database {
  if (!globalForDb.__aiwDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.__aiwDb = createDatabase(url);
  }
  return globalForDb.__aiwDb.db;
}
