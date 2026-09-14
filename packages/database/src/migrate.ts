import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client";

export async function runMigrations(url: string): Promise<void> {
  const handle = createDatabase(url, { max: 1 });
  try {
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    });
  } finally {
    await handle.close();
  }
}

// Executed directly: `pnpm db:migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log("Migrations applied"))
    .catch((error: unknown) => {
      console.error("Migration failed:", error);
      process.exit(1);
    });
}
