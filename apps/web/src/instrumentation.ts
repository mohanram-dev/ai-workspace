/**
 * Runs once when the Next.js server starts. Tasks still marked as running
 * belonged to a previous process, so they are marked interrupted and can be
 * continued by the user.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;

  const [{ recoverInterruptedTasks }, { getDatabase }, { getAgentServices, getScheduler, getServerEnv }] = await Promise.all([
    import("@aiw/agents"),
    import("@aiw/database"),
    import("@aiw/runtime"),
  ]);
  const services = getAgentServices();

  // In queue mode the worker owns execution, so it is the one that recovers
  // interrupted tasks and fires schedules; this process only serves requests.
  if (services.queued) {
    console.info("Task execution is handed to the worker tier over Redis.");
    return;
  }

  try {
    const recovered = await recoverInterruptedTasks(getDatabase(), services.events);
    if (recovered.length > 0) console.warn(`Marked ${recovered.length} interrupted agent task(s) as failed.`);
  } catch (error) {
    console.error("Could not recover interrupted agent tasks", error);
  }

  if (!getServerEnv().RUN_SCHEDULER) return;
  try {
    getScheduler().start();
  } catch (error) {
    console.error("Could not start the scheduler", error);
  }
}
