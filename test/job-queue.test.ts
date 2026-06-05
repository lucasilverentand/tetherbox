import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { JobCanceledError, JobQueue, type JobQueueResult } from "../src/job-queue";
import { StateStore } from "../src/state-store";
import type { RoutedJob } from "../src/types";

describe("JobQueue", () => {
  test("runs jobs up to the configured concurrency", async () => {
    const state = await loadedState();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const queue = new JobQueue({
      concurrency: 2,
      state,
      execute: async (job) => {
        started.push(job.id);
        await new Promise<void>((resolve) => releases.set(job.id, resolve));
        return { status: "completed", message: `${job.id} done` };
      },
    });

    for (const job of [jobFixture("job-1"), jobFixture("job-2"), jobFixture("job-3")]) {
      await state.createJob(job);
      queue.enqueue(job);
    }

    await waitFor(() => started.length === 2);
    expect(queue.stats()).toMatchObject({ concurrency: 2, running: 2, queued: 1 });

    releases.get("job-1")?.();
    await waitFor(() => started.includes("job-3"));
    releases.get("job-2")?.();
    releases.get("job-3")?.();
    await waitFor(() => queue.stats().running === 0);

    expect(state.snapshot().jobs.every((job) => job.status === "completed")).toBe(true);
    state.close();
  });

  test("serializes jobs for the same Linear session", async () => {
    const state = await loadedState();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const queue = new JobQueue({
      concurrency: 2,
      state,
      execute: async (job) => {
        started.push(job.id);
        await new Promise<void>((resolve) => releases.set(job.id, resolve));
        return { status: "completed", message: `${job.id} done` };
      },
    });
    const first = jobFixture("job-1", "session-1");
    const second = jobFixture("job-2", "session-1");
    await state.createJob(first);
    await state.createJob(second);

    queue.enqueue(first);
    queue.enqueue(second);
    await waitFor(() => started.length === 1 && queue.stats().running === 1 && queue.stats().queued === 1);

    expect(started).toEqual(["job-1"]);
    releases.get("job-1")?.();
    await waitFor(() => started.includes("job-2"));
    releases.get("job-2")?.();
    await waitFor(() => queue.stats().running === 0);

    expect(state.snapshot().jobs.every((job) => job.status === "completed")).toBe(true);
    state.close();
  });

  test("does not let same-session serialization block unrelated sessions", async () => {
    const state = await loadedState();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const queue = new JobQueue({
      concurrency: 2,
      state,
      execute: async (job) => {
        started.push(job.id);
        await new Promise<void>((resolve) => releases.set(job.id, resolve));
        return { status: "completed", message: `${job.id} done` };
      },
    });
    const first = jobFixture("job-1", "session-1");
    const blockedSameSession = jobFixture("job-2", "session-1");
    const unrelated = jobFixture("job-3", "session-2");
    for (const job of [first, blockedSameSession, unrelated]) {
      await state.createJob(job);
      queue.enqueue(job);
    }

    await waitFor(() => started.length === 2);

    expect(started).toEqual(["job-1", "job-3"]);
    expect(queue.stats()).toMatchObject({ running: 2, queued: 1 });
    releases.get("job-1")?.();
    await waitFor(() => started.includes("job-2"));
    releases.get("job-2")?.();
    releases.get("job-3")?.();
    await waitFor(() => queue.stats().running === 0);

    expect(state.snapshot().jobs.every((job) => job.status === "completed")).toBe(true);
    state.close();
  });

  test("cancels queued jobs", async () => {
    const state = await loadedState();
    const queue = new JobQueue({
      concurrency: 1,
      state,
      execute: () => new Promise<JobQueueResult>(() => undefined),
    });
    const first = jobFixture("job-1");
    const second = jobFixture("job-2");
    await state.createJob(first);
    await state.createJob(second);

    queue.enqueue(first);
    queue.enqueue(second);
    await waitFor(() => queue.stats().queued === 1);

    expect(await queue.cancel("job-2")).toBe(true);
    expect(state.snapshot().jobs.find((job) => job.id === "job-2")?.status).toBe("canceled");
    state.close();
  });

  test("records retry metadata for failed jobs", async () => {
    const state = await loadedState();
    const queue = new JobQueue({
      concurrency: 1,
      state,
      execute: async () => {
        throw new Error("worker failed");
      },
    });
    const job = jobFixture("job-1");
    await state.createJob(job);

    queue.enqueue(job);
    await waitFor(() => state.snapshot().jobs[0]?.status === "failed");
    const record = state.snapshot().jobs[0];

    expect(record?.retryEligible).toBe(true);
    expect(record?.retryCount).toBe(1);
    expect(record?.failureReason).toBe("worker failed");
    state.close();
  });

  test("marks stale running jobs interrupted on startup", async () => {
    const state = await loadedState();
    const job = jobFixture("job-1");
    await state.createJob(job);
    await state.updateJob(job.id, "running", "Job started");

    const queue = new JobQueue({
      concurrency: 1,
      state,
      execute: async () => ({ status: "completed", message: "done" }),
    });

    const record = state.getJob(job.id);
    expect(queue.stats()).toMatchObject({ running: 0, queued: 0 });
    expect(record).toMatchObject({
      status: "failed",
      lastMessage: "Interrupted by daemon restart",
      retryEligible: true,
      retryCount: 1,
      failureReason: "Interrupted by daemon restart",
    });
    const recoveryEvent = state.snapshot().events.find((event) => event.message === "Interrupted by daemon restart");
    expect(recoveryEvent).toMatchObject({
      jobId: job.id,
      source: "queue",
      level: "warn",
      message: "Interrupted by daemon restart",
    });
    state.close();
  });

  test("times out jobs waiting for approval", async () => {
    const state = await loadedState();
    const queue = new JobQueue({
      concurrency: 1,
      state,
      execute: async (job) => {
        state.createApproval(job.id, "Run local Codex", new Date(Date.now() + 5).toISOString());
        return { status: "waiting_approval", message: "Approval required" };
      },
    });
    const job = jobFixture("job-1");
    await state.createJob(job);

    queue.enqueue(job);
    await waitFor(() => state.snapshot().jobs[0]?.status === "canceled");
    const record = state.snapshot().jobs[0];

    expect(record?.lastMessage).toBe("Approval timed out");
    expect(record?.retryEligible).toBe(false);
    expect(state.getPendingApprovalForJob("job-1")).toBeUndefined();
    state.close();
  });

  test("cancels queued work and aborts in-flight work on shutdown timeout", async () => {
    const state = await loadedState();
    const queue = new JobQueue({
      concurrency: 1,
      state,
      execute: async (_job, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new JobCanceledError()), { once: true });
        });
        return { status: "completed", message: "done" };
      },
    });
    const first = jobFixture("job-1");
    const second = jobFixture("job-2");
    await state.createJob(first);
    await state.createJob(second);

    queue.enqueue(first);
    queue.enqueue(second);
    await waitFor(() => queue.stats().running === 1 && queue.stats().queued === 1);
    await queue.shutdown({ graceMs: 1 });

    const statuses = new Map(state.snapshot().jobs.map((job) => [job.id, job.status]));
    expect(statuses.get("job-1")).toBe("canceled");
    expect(statuses.get("job-2")).toBe("canceled");
    expect(queue.stats()).toMatchObject({ accepting: false, running: 0, queued: 0 });
    state.close();
  });
});

async function loadedState(): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-queue-"));
  const state = new StateStore(join(dir, "daemon.sqlite"));
  await state.load();
  return state;
}

function jobFixture(id: string, sessionId = `session-${id}`): RoutedJob {
  return {
    id,
    sessionId,
    prompt: "Fix it",
    issue: {
      identifier: id.toUpperCase(),
      title: "Fix it",
      labels: ["docs"],
    },
    repo: {
      linearTeams: ["ENG"],
      github: "lucasilverentand/example",
      localPath: "/tmp/example",
      defaultBase: "main",
    },
    policy: {
      ruleName: "docs-auto",
      decision: "allow_auto",
      sandbox: "workspace-write",
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
