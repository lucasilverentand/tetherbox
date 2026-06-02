import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { DaemonEvent, DaemonState, JobRecord, JobStatus, RoutedJob } from "./types";

export class StateStore {
  private state: DaemonState = {
    startedAt: new Date().toISOString(),
    jobs: [],
    events: [],
  };

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      this.state = JSON.parse(raw) as DaemonState;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        throw error;
      }
      await this.save();
    }
  }

  snapshot(): DaemonState {
    return structuredClone(this.state);
  }

  async createJob(job: RoutedJob): Promise<JobRecord> {
    const now = new Date().toISOString();
    const record: JobRecord = {
      id: job.id,
      sessionId: job.sessionId,
      status: "queued",
      repo: job.repo.github,
      issueIdentifier: job.issue.identifier,
      issueTitle: job.issue.title,
      policyRule: job.policy.ruleName,
      policyDecision: job.policy.decision,
      createdAt: now,
      updatedAt: now,
      lastMessage: "Queued",
    };

    this.state.jobs = [record, ...this.state.jobs.filter((existing) => existing.id !== record.id)].slice(0, 200);
    await this.addEvent("info", `Queued job for ${record.repo}`, record.id, false);
    await this.save();
    return record;
  }

  async updateJob(id: string, status: JobStatus, lastMessage: string): Promise<void> {
    const job = this.state.jobs.find((record) => record.id === id);
    if (!job) {
      return;
    }

    job.status = status;
    job.lastMessage = lastMessage;
    job.updatedAt = new Date().toISOString();
    await this.addEvent(status === "failed" ? "error" : "info", lastMessage, id, false);
    await this.save();
  }

  async addEvent(level: DaemonEvent["level"], message: string, jobId?: string, save = true): Promise<void> {
    this.state.events = [
      {
        id: randomUUID(),
        jobId,
        level,
        message,
        createdAt: new Date().toISOString(),
      },
      ...this.state.events,
    ].slice(0, 500);

    if (save) {
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}

export function createJobId(sessionId: string): string {
  return `${sessionId}-${randomUUID().slice(0, 8)}`;
}
