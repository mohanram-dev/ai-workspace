# Web tier: the Next.js server. Agent execution happens here too unless
# REDIS_URL is set, in which case it is handed to the worker image.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

# ── Dependencies ──────────────────────────────────────────────────────────────
# Only the manifests, so a source change does not reinstall the world.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/agents/package.json packages/agents/
COPY packages/ai/package.json packages/ai/
COPY packages/browser/package.json packages/browser/
COPY packages/computer/package.json packages/computer/
COPY packages/database/package.json packages/database/
COPY packages/mcp/package.json packages/mcp/
COPY packages/queue/package.json packages/queue/
COPY packages/runtime/package.json packages/runtime/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/shared/package.json packages/shared/
COPY packages/tools/package.json packages/tools/
RUN pnpm install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
# Secrets are read at runtime, not build time: next.config parses the
# environment lazily so the image contains no configuration.
ENV BUILD_STANDALONE=true
RUN pnpm --filter @aiw/web build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 aiw && useradd --system --uid 1001 --gid aiw aiw

# Next's standalone output carries only the files the server actually needs.
COPY --from=build --chown=aiw:aiw /app/apps/web/.next/standalone ./
COPY --from=build --chown=aiw:aiw /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=aiw:aiw /app/apps/web/public ./apps/web/public
# Migrations, so a deploy can run `pnpm db:migrate` from this image.
COPY --from=build --chown=aiw:aiw /app/packages/database/migrations ./migrations

USER aiw
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
