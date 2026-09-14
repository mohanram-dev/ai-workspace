import { countUsers, getDatabase, schema, writeAuditLog } from "@aiw/database";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { getServerEnv } from "./env";

function createAuth() {
  const env = getServerEnv();
  const db = getDatabase();

  return betterAuth({
    appName: "AI Workspace",
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    user: {
      additionalFields: {
        // `input: false` stops clients from choosing their own role at sign-up.
        role: { type: "string", required: false, input: false, defaultValue: "member" },
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60 * 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: env.APP_URL.startsWith("https://"),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Self-hosted: the first account becomes admin; later sign-ups
            // are refused unless ALLOW_REGISTRATION=true.
            const existingUsers = await countUsers(db);
            if (existingUsers > 0 && !env.ALLOW_REGISTRATION) {
              throw new APIError("FORBIDDEN", { message: "Registration is disabled on this workspace." });
            }
            return { data: { ...user, role: existingUsers === 0 ? "admin" : "member" } };
          },
          after: async (user) => {
            await writeAuditLog(db, {
              userId: user.id,
              action: "auth.user_created",
              resourceType: "user",
              resourceId: user.id,
            });
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            await writeAuditLog(db, {
              userId: session.userId,
              action: "auth.session_created",
              resourceType: "session",
              ipAddress: session.ipAddress ?? null,
              userAgent: session.userAgent ?? null,
            });
          },
        },
      },
    },
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

const globalForAuth = globalThis as unknown as { __aiwAuth?: Auth };

export function getAuth(): Auth {
  globalForAuth.__aiwAuth ??= createAuth();
  return globalForAuth.__aiwAuth;
}

export async function isRegistrationOpen(): Promise<boolean> {
  if (getServerEnv().ALLOW_REGISTRATION) return true;
  return (await countUsers(getDatabase())) === 0;
}
