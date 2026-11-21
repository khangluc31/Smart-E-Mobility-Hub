// Interval job registry (D-02, NFR-27). Jobs read all state from Postgres each run,
// so a restart loses nothing. No job is registered here — modules register theirs.
interface Job {
  name: string;
  everyMs: number;
  fn: (now: Date) => Promise<void>;
  timer?: NodeJS.Timeout;
  running: boolean;
}

const jobs = new Map<string, Job>();

export function registerJob(name: string, everyMs: number, fn: (now: Date) => Promise<void>): void {
  if (jobs.has(name)) throw new Error(`Job "${name}" is already registered`);
  jobs.set(name, { name, everyMs, fn, running: false });
}

// One guarded run: never overlaps itself, never throws, logs failures.
async function runGuarded(job: Job, now: Date): Promise<void> {
  if (job.running) return;
  job.running = true;
  try {
    await job.fn(now);
  } catch (err) {
    console.error(`[scheduler] job "${job.name}" failed`, err);
  } finally {
    job.running = false;
  }
}

export function startJobs(): void {
  for (const job of jobs.values()) {
    if (job.timer) continue;
    job.timer = setInterval(() => void runGuarded(job, new Date()), job.everyMs);
    if (typeof job.timer.unref === 'function') job.timer.unref();
  }
}

export function stopJobs(): void {
  for (const job of jobs.values()) {
    if (job.timer) {
      clearInterval(job.timer);
      job.timer = undefined;
    }
  }
}

// For tests: run one job immediately with a controllable clock.
export async function runJobOnce(name: string, now: Date = new Date()): Promise<void> {
  const job = jobs.get(name);
  if (!job) throw new Error(`Job "${name}" is not registered`);
  await runGuarded(job, now);
}
