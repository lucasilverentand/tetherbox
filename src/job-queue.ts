import type { StateStore } from "./state-store";
import type { DaemonState, RoutedJob } from "./types";

export interface JobQueueOptions {
  concurrency: number;
  state: StateStore;
  execute: (job: RoutedJob, signal: AbortSignal) => Promise<JobQueueResult>;
}

export interface JobQueueResult {
  status: "completed" | "waiting_approval" | "denied";
  message: string;
}

export interface ShutdownOptions {
  graceMs: number;
}

interface RunningJob {
  controller: AbortController;
  promise: Promise<void>;
}

export class JobCanceledError extends Error {
  constructor(message = "Job canceled") {
    super(message);
    this.name = "JobCanceledError";
  }
}

export class JobQueue {
  private accepting = true;
  private readonly pending: RoutedJob[] = [];
  private readonly running = new Map<string, RunningJob>();
  private readonly approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: JobQueueOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error("Queue concurrency must be at least 1");
    }
    this.scheduleExistingApprovalTimeouts();
  }

  stats(): NonNullable<DaemonState["queue"]> {
    return {
      accepting: this.accepting,
      concurrency: this.options.concurrency,
      running: this.running.size,
      queued: this.pending.length,
    };
  }

  enqueue(job: RoutedJob): void {
    if (!this.accepting) {
      throw new Error("Daemon is shutting down and is not accepting new jobs");
    }

    this.pending.push(job);
    this.pump();
  }

  async cancel(jobId: string): Promise<boolean> {
    const pendingIndex = this.pending.findIndex((job) => job.id === jobId);
    if (pendingIndex !== -1) {
      this.pending.splice(pendingIndex, 1);
      await this.options.state.updateJob(jobId, "canceled", "Canceled before running");
      return true;
    }

    const running = this.running.get(jobId);
    if (!running) {
      return false;
    }

    running.controller.abort();
    await this.options.state.addEvent("warn", "Cancellation requested", jobId, "queue");
    return true;
  }

  async shutdown(options: ShutdownOptions): Promise<void> {
    this.accepting = false;

    const queued = this.pending.splice(0);
    await Promise.all(queued.map((job) => this.options.state.updateJob(job.id, "canceled", "Canceled during shutdown")));

    const inFlight = [...this.running.values()].map((job) => job.promise);
    if (inFlight.length === 0) {
      this.clearApprovalTimers();
      return;
    }

    const settled = Promise.allSettled(inFlight).then(() => undefined);
    const timedOut = sleep(options.graceMs).then(() => "timeout" as const);
    if ((await Promise.race([settled, timedOut])) === "timeout") {
      for (const job of this.running.values()) {
        job.controller.abort();
      }
      await Promise.allSettled(inFlight);
    }
    this.clearApprovalTimers();
  }

  private pump(): void {
    while (this.running.size < this.options.concurrency) {
      const job = this.pending.shift();
      if (!job) {
        return;
      }

      const controller = new AbortController();
      const promise = this.run(job, controller).finally(() => {
        this.running.delete(job.id);
        this.pump();
      });
      this.running.set(job.id, { controller, promise });
    }
  }

  private async run(job: RoutedJob, controller: AbortController): Promise<void> {
    await this.options.state.updateJob(job.id, "running", "Job started");

    try {
      const result = await this.options.execute(job, controller.signal);
      await this.options.state.updateJob(job.id, result.status, result.message);
      if (result.status === "waiting_approval") {
        this.scheduleApprovalTimeout(job.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Job failed";
      if (error instanceof JobCanceledError || controller.signal.aborted) {
        await this.options.state.updateJob(job.id, "canceled", message);
        return;
      }

      await this.options.state.updateJob(job.id, "failed", message, {
        failureReason: message,
        incrementRetryCount: true,
        retryEligible: true,
      });
    }
  }

  private scheduleExistingApprovalTimeouts(): void {
    for (const approval of this.options.state.listPendingApprovals()) {
      this.scheduleApprovalTimeout(approval.jobId);
    }
  }

  private scheduleApprovalTimeout(jobId: string): void {
    const approval = this.options.state.getPendingApprovalForJob(jobId);
    if (!approval?.expiresAt) {
      return;
    }

    const existing = this.approvalTimers.get(jobId);
    if (existing) {
      clearTimeout(existing);
    }
    const expiresAt = Date.parse(approval.expiresAt);
    if (Number.isNaN(expiresAt)) {
      return;
    }
    const delay = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(() => {
      void this.expireApproval(jobId);
    }, delay);
    this.approvalTimers.set(jobId, timer);
  }

  private async expireApproval(jobId: string): Promise<void> {
    this.approvalTimers.delete(jobId);
    const expired = this.options.state.expirePendingApproval(jobId);
    if (!expired) {
      return;
    }

    await this.options.state.updateJob(jobId, "canceled", "Approval timed out", {
      retryEligible: false,
      failureReason: "Approval timed out",
    });
  }

  private clearApprovalTimers(): void {
    for (const timer of this.approvalTimers.values()) {
      clearTimeout(timer);
    }
    this.approvalTimers.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
