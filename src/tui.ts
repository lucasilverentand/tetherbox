import type { DaemonEvent, DaemonState, JobRecord } from "./types";

export interface TuiOptions {
  url: string;
  intervalMs: number;
  operatorToken?: string;
}

export type TuiView = "jobs" | "job" | "events" | "event";

export interface TuiUiState {
  view: TuiView;
  selectedJob: number;
  selectedEvent: number;
  message?: string;
}

export async function runTui(options: TuiOptions): Promise<void> {
  let stopped = false;
  let latest: DaemonState | undefined;
  const ui: TuiUiState = {
    view: "jobs",
    selectedJob: 0,
    selectedEvent: 0,
  };

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
    void handleKey(options, ui, latest, key).then((state) => {
      latest = state ?? latest;
      if (latest) {
        drawState(latest, ui, options);
      }
    });
  });

  process.stdout.write("\x1b[?25l");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopped) {
    latest = await fetchState(options, ui);
    if (latest) {
      clampSelection(ui, latest);
      drawState(latest, ui, options);
    }
    await sleep(options.intervalMs);
  }
}

async function fetchState(options: TuiOptions, ui: TuiUiState): Promise<DaemonState | undefined> {
  try {
    const response = await fetch(new URL("/api/status", options.url));
    if (!response.ok) {
      throw new Error(`daemon returned ${response.status}`);
    }

    return (await response.json()) as DaemonState;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`Daemon unavailable at ${options.url}: ${message}\n`);
    ui.message = message;
    return undefined;
  }
}

function drawState(state: DaemonState, ui: TuiUiState, options: TuiOptions): void {
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(renderTui(state, ui, options));
}

export function renderTui(state: DaemonState, ui: TuiUiState, options: Pick<TuiOptions, "intervalMs" | "url">): string {
  clampSelection(ui, state);
  const lines: string[] = [];
  lines.push("Tetherbox");
  lines.push(
    [
      "q quit",
      "tab switch",
      "enter detail",
      "esc back",
      "j/k move",
      "c cancel",
      "r retry",
      "a approve",
      "d deny",
      `refresh ${options.intervalMs}ms`,
    ].join(" | "),
  );
  lines.push("");
  lines.push(`Daemon: ${formatDate(state.startedAt)} | Jobs: ${state.jobs.length} | Events: ${state.events.length}`);
  if (state.queue) {
    const accepting = state.queue.accepting ? "accepting" : "draining";
    lines.push(
      `Queue: ${accepting} | running ${state.queue.running}/${state.queue.concurrency} | queued ${state.queue.queued}`,
    );
  }
  if (ui.message) {
    lines.push(`Message: ${ui.message}`);
  }
  lines.push("");

  if (ui.view === "job") {
    renderJobDetail(lines, state.jobs[ui.selectedJob], state.events);
  } else if (ui.view === "events") {
    renderEvents(lines, state.events, ui.selectedEvent);
  } else if (ui.view === "event") {
    renderEventDetail(lines, state.events[ui.selectedEvent]);
  } else {
    renderJobs(lines, state.jobs, ui.selectedJob);
  }

  return `${lines.join("\n")}\n`;
}

async function handleKey(
  options: TuiOptions,
  ui: TuiUiState,
  state: DaemonState | undefined,
  key: string,
): Promise<DaemonState | undefined> {
  ui.message = undefined;
  if (!state) {
    return undefined;
  }

  if (key === "\t") {
    ui.view = ui.view === "jobs" || ui.view === "job" ? "events" : "jobs";
    return state;
  }
  if (key === "\r" || key === "\n") {
    ui.view = ui.view === "events" ? "event" : ui.view === "jobs" ? "job" : ui.view;
    return state;
  }
  if (key === "\u001b") {
    ui.view = ui.view === "event" ? "events" : ui.view === "job" ? "jobs" : ui.view;
    return state;
  }
  if (key === "j") {
    if (ui.view === "events" || ui.view === "event") {
      ui.selectedEvent += 1;
    } else {
      ui.selectedJob += 1;
    }
    clampSelection(ui, state);
    return state;
  }
  if (key === "k") {
    if (ui.view === "events" || ui.view === "event") {
      ui.selectedEvent -= 1;
    } else {
      ui.selectedJob -= 1;
    }
    clampSelection(ui, state);
    return state;
  }
  if (["c", "r", "a", "d"].includes(key)) {
    return performJobAction(options, ui, state, key);
  }

  return state;
}

async function performJobAction(
  options: TuiOptions,
  ui: TuiUiState,
  state: DaemonState,
  key: string,
): Promise<DaemonState | undefined> {
  const job = state.jobs[ui.selectedJob];
  if (!job) {
    return state;
  }
  const action = key === "c" ? "cancel" : key === "r" ? "retry" : key === "a" ? "approve" : "deny";
  const response = await fetch(new URL(`/api/jobs/${encodeURIComponent(job.id)}/${action}`, options.url), {
    method: "POST",
    headers: options.operatorToken ? { Authorization: `Bearer ${options.operatorToken}` } : undefined,
  });
  const result = (await response.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
  ui.message = result.ok ? `${action} sent for ${job.id}` : `${action} failed: ${result.reason ?? response.status}`;
  return fetchState(options, ui);
}

function renderJobs(lines: string[], jobs: JobRecord[], selected: number): void {
  lines.push("Jobs");
  lines.push("----");
  if (jobs.length === 0) {
    lines.push("No jobs yet.");
    return;
  }
  for (const [index, job] of jobs.slice(0, 15).entries()) {
    lines.push(`${index === selected ? ">" : " "} ${formatJob(job)} ${formatActions(job)}`);
  }
}

function renderJobDetail(lines: string[], job: JobRecord | undefined, events: DaemonEvent[]): void {
  lines.push("Job Detail");
  lines.push("----------");
  if (!job) {
    lines.push("No job selected.");
    return;
  }
  lines.push(`ID: ${job.id}`);
  lines.push(`Session: ${job.sessionId}`);
  lines.push(`Status: ${job.status}`);
  lines.push(`Repo: ${job.repo}`);
  lines.push(`Issue: ${job.issueIdentifier ?? "none"} ${job.issueTitle ?? ""}`.trim());
  lines.push(`Policy: ${job.policyRule} -> ${job.policyDecision}`);
  lines.push(`Branch: ${job.branchName ?? "none"}`);
  lines.push(`Worktree: ${job.worktreePath ?? "none"}`);
  lines.push(`Retry: ${job.retryEligible ? "eligible" : "not eligible"} | Count: ${job.retryCount}`);
  lines.push(`Last: ${job.lastMessage}`);
  if (job.failureReason) {
    lines.push(`Failure: ${job.failureReason}`);
  }
  lines.push("");
  lines.push(`Actions: ${formatActions(job) || "none"}`);
  lines.push("");
  lines.push("Recent Job Events");
  for (const event of events.filter((candidate) => candidate.jobId === job.id).slice(0, 8)) {
    lines.push(formatEvent(event));
  }
}

function renderEvents(lines: string[], events: DaemonEvent[], selected: number): void {
  lines.push("Events");
  lines.push("------");
  if (events.length === 0) {
    lines.push("No events yet.");
    return;
  }
  for (const [index, event] of events.slice(0, 20).entries()) {
    lines.push(`${index === selected ? ">" : " "} ${formatEvent(event)}`);
  }
}

function renderEventDetail(lines: string[], event: DaemonEvent | undefined): void {
  lines.push("Event Detail");
  lines.push("------------");
  if (!event) {
    lines.push("No event selected.");
    return;
  }
  lines.push(`ID: ${event.id}`);
  lines.push(`Job: ${event.jobId ?? "none"}`);
  lines.push(`Source: ${event.source}`);
  lines.push(`Level: ${event.level}`);
  lines.push(`Created: ${event.createdAt}`);
  lines.push("");
  lines.push(event.message);
}

function formatJob(job: JobRecord): string {
  const issue = job.issueIdentifier ?? "no issue";
  const title = truncate(job.issueTitle ?? "", 34);
  const status = job.status.toUpperCase().padEnd(16);
  return `${formatDate(job.updatedAt)} ${status} ${issue.padEnd(12)} ${truncate(job.repo, 28).padEnd(28)} ${title}`;
}

function formatEvent(event: DaemonEvent): string {
  return `${formatDate(event.createdAt)} ${event.level.toUpperCase().padEnd(5)} ${event.source.padEnd(10)} ${truncate(event.message, 92)}`;
}

function formatActions(job: JobRecord): string {
  const actions: string[] = [];
  if (job.status === "queued" || job.status === "running" || job.status === "waiting_approval") {
    actions.push("c cancel");
  }
  if (job.retryEligible) {
    actions.push("r retry");
  }
  if (job.status === "waiting_approval") {
    actions.push("a approve", "d deny");
  }
  return actions.join(" | ");
}

function clampSelection(ui: TuiUiState, state: DaemonState): void {
  ui.selectedJob = Math.max(0, Math.min(ui.selectedJob, Math.max(0, state.jobs.length - 1)));
  ui.selectedEvent = Math.max(0, Math.min(ui.selectedEvent, Math.max(0, state.events.length - 1)));
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
