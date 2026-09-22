import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Monorepo: load the shared root .env. Existing environment variables win.
const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const isDev = process.env.NODE_ENV !== "production";
const isHttps = process.env.APP_URL?.startsWith("https://") ?? false;

/**
 * Next.js injects inline bootstrap scripts, so script-src needs
 * 'unsafe-inline' without a nonce-based setup. Everything else is locked to
 * same-origin; the browser never talks to model providers directly.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isHttps ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(!isHttps ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // A self-contained server bundle for the Docker image, which then ships no
  // node_modules. Only under BUILD_STANDALONE, because `next start` does not
  // serve a standalone build and that is how the app is run locally.
  ...(process.env.BUILD_STANDALONE === "true"
    ? {
        output: "standalone" as const,
        // The monorepo root, so tracing follows workspace packages into the bundle.
        outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
        // playwright-core reads browsers.json at load time, and tracing only
        // follows JavaScript, so the bundle has to be told to carry it.
        outputFileTracingIncludes: {
          "**": ["../../node_modules/.pnpm/playwright-core@*/node_modules/playwright-core/browsers.json"],
        },
      }
    : {}),
  transpilePackages: [
    "@aiw/agents",
    "@aiw/ai",
    "@aiw/browser",
    "@aiw/computer",
    "@aiw/database",
    "@aiw/mcp",
    "@aiw/queue",
    "@aiw/runtime",
    "@aiw/scheduler",
    "@aiw/shared",
    "@aiw/tools",
  ],
  serverExternalPackages: ["postgres", "playwright-core", "ioredis", "bullmq"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Workspace files are served from this origin for the viewer (images,
      // PDFs, media). A route handler cannot weaken the rule above — Next
      // replaces a same-named header — and the app's own policy allows
      // `script-src 'unsafe-inline'`, which would let a directly-opened SVG
      // run its script on this origin. This rule is more specific, so it wins
      // here and makes that response inert wherever it is opened.
      { source: "/api/files/content", headers: [{ key: "Content-Security-Policy", value: "sandbox; default-src 'none'" }] },
    ];
  },
};

export default nextConfig;
