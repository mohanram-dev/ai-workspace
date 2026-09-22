import { insertAgentsIfMissing, type Database, type NewAgent } from "@aiw/database";
import type { PlanningMode } from "@aiw/shared";

export interface BuiltinAgentDefinition {
  slug: string;
  name: string;
  /** Used by the router to decide which agent fits a task. */
  description: string;
  instructions: string;
  temperature: number;
  planningMode: PlanningMode;
  maxSteps: number;
  /** Default tool assignment and granted permissions (READ is implicit). */
  tools: string[];
  permissions: string[];
}

/**
 * Default agents from the product spec with their default tools. The runtime
 * tells every agent exactly which tools it has and what it cannot do.
 */
export const BUILTIN_AGENTS: BuiltinAgentDefinition[] = [
  {
    slug: "general",
    name: "General Agent",
    description: "General-purpose assistant for questions, explanations, writing, brainstorming and everyday tasks that do not fit a specialist.",
    instructions:
      "You are a capable general-purpose assistant. Understand what the user actually needs, answer directly, and structure longer answers with headings and lists.",
    temperature: 0.7,
    planningMode: "auto",
    maxSteps: 4,
    // DESTRUCTIVE is never granted — schedule.create always asks the human.
    // WRITE is what schedule.disable needs.
    tools: ["web.search","web.fetch","schedule.create","schedule.list","schedule.disable"],
    permissions: ["NETWORK","WRITE"],
  },
  {
    slug: "coding",
    name: "Coding Agent",
    description: "Writes, reviews, explains and debugs code; TypeScript/JavaScript, Python and other languages; tests, git workflows and build errors.",
    instructions:
      "You are a senior software engineer. Produce correct, idiomatic, production-quality code with brief explanations. When debugging, identify the root cause before proposing a fix. Prefer complete, runnable snippets and mention how to verify them.",
    temperature: 0.2,
    planningMode: "auto",
    maxSteps: 5,
    tools: ["files.list","files.read","files.search","files.write","files.edit","files.delete","git.status","git.diff","git.log","git.init","git.add","git.commit","terminal.run","github.search_repositories","github.list_issues","github.read_issue"],
    permissions: ["WRITE","EXECUTE","NETWORK"],
  },
  {
    slug: "research",
    name: "Research Agent",
    description: "Researches topics, compares options, analyses information and produces structured reports such as comparisons and summaries.",
    instructions:
      "You are a meticulous research analyst. Break topics into clear questions, compare options with explicit criteria, separate facts from judgement, and produce well-structured Markdown reports. State clearly when information may be outdated because you cannot access live sources.",
    temperature: 0.4,
    planningMode: "always",
    maxSteps: 6,
    tools: ["web.search","web.fetch","files.list","files.read","files.search","files.write","github.search_repositories"],
    permissions: ["NETWORK","WRITE"],
  },
  {
    slug: "browser",
    name: "Browser Agent",
    description: "Browses websites interactively: opens pages, clicks, fills forms, scrolls and extracts information. Use for tasks that need navigation or interaction, not just reading a page.",
    instructions:
      "You are a browser automation specialist. Use browser.open to load a page, then read the numbered elements and page text you get back. Act with browser.click, browser.type, browser.select, browser.scroll and browser.press, and check the returned page after every action before deciding the next one. Prefer web.search to find URLs, then browse. Never enter credentials or payment details, and stop and report when a page asks for a login or CAPTCHA. Report exactly what you found, citing the URLs you visited.",
    temperature: 0.3,
    planningMode: "auto",
    maxSteps: 4,
    tools: ["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.press","browser.scroll","browser.back","browser.screenshot","browser.close","web.search","web.fetch"],
    permissions: ["NETWORK","EXECUTE"],
  },
  {
    slug: "computer-use",
    name: "Computer Use Agent",
    description: "Controls the computer's desktop directly: mouse, keyboard and screen. Use for desktop applications, the file manager, IDEs and other graphical interfaces that are not web pages.",
    instructions:
      "You are a desktop automation specialist. Start with computer.start to see the screen, then work in small, deliberate steps: look at each screenshot, decide one action, take it, and look again. Click a field before typing. Use computer.wait after launching apps or triggering slow actions. Before anything destructive or irreversible (deleting files, sending messages, making purchases), stop and ask the user. Report what you did and what is on screen.",
    temperature: 0.2,
    planningMode: "auto",
    maxSteps: 6,
    tools: ["computer.start","computer.screenshot","computer.click","computer.move","computer.drag","computer.scroll","computer.type","computer.key","computer.wait","computer.stop"],
    permissions: ["EXECUTE"],
  },
  {
    slug: "devops",
    name: "DevOps Agent",
    description: "Docker containers, Linux servers, logs, remote hosts over SSH, deployments, CI/CD, networking, monitoring and infrastructure troubleshooting.",
    instructions:
      "You are a senior DevOps/SRE engineer. Diagnose systematically from symptoms to root cause, give exact commands with explanations of what they do, warn before any destructive or production-impacting command, and include verification steps.",
    temperature: 0.2,
    planningMode: "auto",
    maxSteps: 5,
    tools: ["terminal.run","files.list","files.read","files.search","web.search","web.fetch","docker.ps","docker.logs","docker.stats","docker.inspect","docker.restart","docker.stop","docker.remove","ssh.run"],
    permissions: ["EXECUTE","NETWORK"],
  },
  {
    slug: "file",
    name: "File Agent",
    description: "Reads, creates, edits, organises and searches files and documents, including drafting file contents.",
    instructions:
      "You are a meticulous file and document specialist. Produce complete file contents when asked, preserve existing structure when editing, and explain any organisation scheme you propose.",
    temperature: 0.3,
    planningMode: "auto",
    maxSteps: 4,
    tools: ["files.list","files.read","files.search","files.write","files.edit","files.delete"],
    permissions: ["WRITE"],
  },
  {
    slug: "manager",
    name: "Manager Agent",
    description:
      "Coordinates work that needs several specialists: splits a large request into pieces, delegates each to the right agent, and combines their results into one answer.",
    instructions:
      "You are a project manager for a team of specialist agents. Use agent.delegate for work that needs another agent's tools or expertise, and do simple work yourself instead of delegating it. " +
      "Each delegated agent starts fresh and cannot see this conversation, so every instruction you send must be complete on its own. " +
      "Delegate one self-contained piece at a time, wait for the result, and pass anything the next agent needs in its instruction. " +
      "You have a limited number of delegations, so plan them before you start. Finish by combining the results into one answer in your own words, saying which agent produced what, and reporting plainly anything that failed or is still missing.",
    temperature: 0.3,
    planningMode: "always",
    maxSteps: 5,
    tools: ["agent.delegate","files.list","files.read","files.write"],
    permissions: ["EXECUTE","WRITE"],
  },
];

export const DEFAULT_AGENT_SLUG = "general";

/** Idempotently creates the built-in agents for a user. */
export async function ensureBuiltinAgents(db: Database, userId: string): Promise<void> {
  const rows: NewAgent[] = BUILTIN_AGENTS.map((agent) => ({
    ownerId: userId,
    slug: agent.slug,
    builtin: true,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    temperature: agent.temperature,
    planningMode: agent.planningMode,
    maxSteps: agent.maxSteps,
    tools: agent.tools,
    permissions: agent.permissions,
  }));
  await insertAgentsIfMissing(db, rows);
}
