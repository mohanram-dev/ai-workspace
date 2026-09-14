import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { SignOutButton } from "@/features/auth/sign-out-button";
import Link from "next/link";
import { getServerEnv } from "@/server/env";
import { getBrowserManager } from "@/server/browser";
import { getComputerManager } from "@/server/computer";
import { isAdmin } from "@/server/mcp";
import { getProviderRegistry } from "@/server/providers";
import { getToolRegistry, getWorkspaceRoot } from "@/server/tools";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { user } = await requirePageSession();
  const env = getServerEnv();
  const providers = getProviderRegistry().list();

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">Account, appearance and workspace configuration.</p>
        </div>

        <Section title="Account">
          <Row label="Name">{user.name}</Row>
          <Row label="Email">{user.email}</Row>
          <Row label="Role">
            <Badge variant="secondary" className="capitalize">
              {typeof user.role === "string" ? user.role : "member"}
            </Badge>
          </Row>
          <Row label="Session">
            <SignOutButton />
          </Row>
        </Section>

        <Section title="Appearance">
          <Row label="Theme">
            <ThemeToggle />
          </Row>
        </Section>

        <Section
          title="Model providers"
          description="Provider credentials are read from the server environment and never sent to the browser."
        >
          {providers.map((provider) => (
            <Row key={provider.id} label={provider.name}>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {provider.isConfigured() ? (
                  <>
                    <Badge variant="outline" className="border-success/40 bg-success/10 text-foreground">
                      Configured
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">default: {provider.defaultModel}</span>
                  </>
                ) : (
                  <Badge variant="outline" className="border-warning/40 bg-warning/10 text-foreground">
                    Not configured — set GEMINI_API_KEY
                  </Badge>
                )}
              </div>
            </Row>
          ))}
          <Row label="OpenAI-compatible, Claude, Ollama">
            <Badge variant="outline" className="font-mono text-[0.7rem]">
              NOT IMPLEMENTED
            </Badge>
          </Row>
        </Section>

        <Section title="Tools" description="Configured through environment variables on the server.">
          <Row label="Workspace directory">
            <span className="font-mono text-xs break-all">{getWorkspaceRoot()}</span>
          </Row>
          <Row label="Terminal">
            {env.TERMINAL_ENABLED ? (
              <span className="text-xs">
                Enabled · <span className="font-mono">{env.TERMINAL_ALLOWED_COMMANDS.join(", ")}</span>
              </span>
            ) : (
              <Badge variant="outline">Disabled (TERMINAL_ENABLED=false)</Badge>
            )}
          </Row>
          <Row label="Web search">
            {getToolRegistry().availability("web.search").available ? (
              <span className="text-xs">
                {env.WEB_SEARCH_PROVIDER === "gemini" ? `Gemini Google Search · ${env.WEB_SEARCH_MODEL}` : "SearXNG"}
              </span>
            ) : (
              <Badge variant="outline">{getToolRegistry().availability("web.search").reason ?? "Unavailable"}</Badge>
            )}
          </Row>
          <Row label="Private network access (web.fetch)">{env.WEB_FETCH_ALLOW_PRIVATE_NETWORK ? "Allowed" : "Blocked"}</Row>
          <Row label="Browser">
            {getBrowserManager().availability().available ? (
              <span className="text-xs">
                Headless {env.BROWSER_CHANNEL ?? "Chromium"} · up to {env.BROWSER_MAX_SESSIONS} sessions · private network{" "}
                {env.BROWSER_ALLOW_PRIVATE_NETWORK ? "allowed" : "blocked"}
              </span>
            ) : (
              <Badge variant="outline">{getBrowserManager().availability().reason}</Badge>
            )}
          </Row>
          <Row label="Computer use">
            {getComputerManager().availability().available ? (
              <span className="text-xs">Enabled · controls this server&apos;s desktop · screenshots up to {env.COMPUTER_MAX_WIDTH}px wide</span>
            ) : (
              <Badge variant="outline">{getComputerManager().availability().reason}</Badge>
            )}
          </Row>
        </Section>

        <Section title="MCP" description="Servers are managed per user on the MCP Tools page; these limits apply to everyone.">
          <Row label="stdio servers">
            {env.MCP_STDIO_ENABLED ? (
              <span className="text-xs">Enabled · administrators only{isAdmin(user) ? " (you are an administrator)" : ""}</span>
            ) : (
              <Badge variant="outline">Disabled (MCP_STDIO_ENABLED=false)</Badge>
            )}
          </Row>
          <Row label="Private network access (http servers)">{env.MCP_ALLOW_PRIVATE_NETWORK ? "Allowed" : "Blocked"}</Row>
          <Row label="Stored secrets">Header and environment values are encrypted with a key derived from BETTER_AUTH_SECRET.</Row>
          <Row label="Manage">
            <Link href="/mcp" className="text-xs underline underline-offset-2">
              MCP Tools
            </Link>
          </Row>
        </Section>

        <Section title="Approvals" description="Destructive tool calls pause the task until you decide.">
          <Row label="Request timeout">{env.APPROVAL_TIMEOUT_MINUTES} minutes, then the action is refused</Row>
          <Row label="Scope options">Reject · Approve once · Approve for this task</Row>
        </Section>

        <Section title="Workspace">
          <Row label="Public registration">{env.ALLOW_REGISTRATION ? "Enabled" : "Disabled"}</Row>
          <Row label="Chat and task rate limit">{env.CHAT_RATE_LIMIT_PER_MINUTE} requests / minute per user</Row>
          <Row label="Router model">
            <span className="font-mono text-xs">{env.ROUTER_MODEL ?? `${env.GEMINI_DEFAULT_MODEL} (default)`}</span>
          </Row>
          <Row label="Running tasks per user">{env.MAX_RUNNING_TASKS_PER_USER}</Row>
          <Row label="Task execution">In-process (single server). Queue-based workers arrive in Phase 12.</Row>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="border-b px-4 py-3 sm:px-5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </header>
      <dl className="divide-y">{children}</dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm sm:text-right">{children}</dd>
    </div>
  );
}
