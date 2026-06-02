import type { DaemonState, JobRecord } from "./types";

export interface TuiOptions {
  url: string;
  intervalMs: number;
}

export async function runTui(options: TuiOptions): Promise<void> {
  let stopped = false;

  const stop = () => {
    stopped = true;
    process.stdout.write("\x1b[?25h\x1b[0m\x1b[2J\x1b[H");
    process.exit(0);
  };

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    const key = data.toString();
    if (key === "q" || data[0] === 3) {
      stop();
    }
  });

  process.stdout.write("\x1b[?25l");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopped) {
    await draw(options);
    await sleep(options.intervalMs);
  }
}

async function draw(options: TuiOptions): Promise<void> {
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write("Local Linear Codex Bridge\n");
  process.stdout.write(`q: quit | refresh: ${options.intervalMs}ms\n\n`);

  try {
    const response = await fetch(new URL("/api/status", options.url));
    if (!response.ok) {
      throw new Error(`daemon returned ${response.status}`);
    }

    const state = (await response.json()) as DaemonState;
    process.stdout.write(`Daemon started: ${formatDate(state.startedAt)}\n`);
    process.stdout.write(`Jobs: ${state.jobs.length} | Events: ${state.events.length}\n\n`);
    process.stdout.write("Recent Jobs\n");
    process.stdout.write("-----------\n");

    for (const job of state.jobs.slice(0, 12)) {
      process.stdout.write(formatJob(job));
    }

    if (state.jobs.length === 0) {
      process.stdout.write("No jobs yet.\n");
    }

    process.stdout.write("\nRecent Events\n");
    process.stdout.write("-------------\n");
    for (const event of state.events.slice(0, 10)) {
      process.stdout.write(
        `${formatDate(event.createdAt)} ${event.level.toUpperCase().padEnd(5)} ${truncate(event.message, 86)}\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stdout.write(`Daemon unavailable at ${options.url}: ${message}\n`);
  }
}

function formatJob(job: JobRecord): string {
  const issue = job.issueIdentifier ?? "no issue";
  const title = truncate(job.issueTitle ?? "", 34);
  const status = job.status.toUpperCase().padEnd(16);
  return `${formatDate(job.updatedAt)} ${status} ${issue.padEnd(12)} ${truncate(job.repo, 28).padEnd(28)} ${title}\n`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function truncate(value: string, length: number): string {
  if (value.length <= length) {
    return value;
  }
  return `${value.slice(0, length - 3)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
