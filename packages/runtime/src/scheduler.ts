import { getDatabase } from "@aiw/database";
import { Scheduler } from "@aiw/scheduler";
import { getAgentServices } from "./agents";

const globalForScheduler = globalThis as unknown as { __aiwScheduler?: Scheduler };

/**
 * The process-wide scheduler ticker. Exactly one process should start it; in
 * queue mode that is the worker, otherwise the web server's instrumentation.
 * Claiming a due schedule is atomic, so a second ticker cannot double-fire.
 */
export function getScheduler(): Scheduler {
  if (!globalForScheduler.__aiwScheduler) {
    globalForScheduler.__aiwScheduler = new Scheduler({ db: getDatabase(), tasks: getAgentServices().tasks });
  }
  return globalForScheduler.__aiwScheduler;
}
