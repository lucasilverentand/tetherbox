import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { DaemonEvent, DaemonState, JobRecord, JobStatus, RepoMapping, RoutedJob } from "./types";
import type { WorktreeInfo } from "./worktree-manager";

interface JobRow {
  id: string;
  session_id: string;
  status: JobStatus;
  repo: string;
  branch_name: string | null;
  worktree_path: string | null;
  issue_identifier: string | null;
  issue_title: string | null;
  policy_rule: string;
  policy_decision: JobRecord["policyDecision"];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  last_message: string;
  retry_eligible: number;
  retry_count: number;
  failure_reason: string | null;
}

interface EventRow {
  id: string;
  job_id: string | null;
  level: DaemonEvent["level"];
  message: string;
  created_at: string;
}

interface MetadataRow {
  value: string;
}

export interface JobUpdateOptions {
  retryEligible?: boolean;
  incrementRetryCount?: boolean;
  failureReason?: string;
}

export class StateStore {
  private db?: Database;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.ensureStartedAt();
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  snapshot(queue?: DaemonState["queue"]): DaemonState {
    const db = this.requireDb();
    const startedAt = this.getMetadata("started_at");
    const jobs = db
      .query("select * from jobs order by updated_at desc, created_at desc limit 200")
      .all()
      .map((row) => jobFromRow(row as JobRow));
    const events = db
      .query("select * from job_events order by created_at desc, id desc limit 500")
      .all()
      .map((row) => eventFromRow(row as EventRow));

    return { startedAt, queue, jobs, events };
  }

  syncRepoMappings(repos: RepoMapping[]): void {
    const db = this.requireDb();
    const now = new Date().toISOString();
    const upsert = db.query(
      `insert into repo_mappings (
        github, local_path, default_base, linear_teams_json, test_commands_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(github) do update set
        local_path = excluded.local_path,
        default_base = excluded.default_base,
        linear_teams_json = excluded.linear_teams_json,
        test_commands_json = excluded.test_commands_json,
        updated_at = excluded.updated_at`,
    );

    db.transaction(() => {
      for (const repo of repos) {
        upsert.run(
          repo.github,
          repo.localPath,
          repo.defaultBase,
          JSON.stringify(repo.linearTeams),
          JSON.stringify(repo.testCommands ?? []),
          now,
          now,
        );
      }
    })();
  }

  async createJob(job: RoutedJob): Promise<JobRecord> {
    const db = this.requireDb();
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
      retryEligible: false,
      retryCount: 0,
    };

    db.transaction(() => {
      db.query(
        `insert into sessions (
          id, issue_id, issue_identifier, issue_title, repo, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          issue_id = excluded.issue_id,
          issue_identifier = excluded.issue_identifier,
          issue_title = excluded.issue_title,
          repo = excluded.repo,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      ).run(
        job.sessionId,
        job.issue.id ?? null,
        job.issue.identifier ?? null,
        job.issue.title ?? null,
        job.repo.github,
        "active",
        now,
        now,
      );
      db.query(
        `insert into jobs (
          id, session_id, status, repo, issue_identifier, issue_title, policy_rule,
          policy_decision, created_at, updated_at, last_message, retry_eligible, retry_count
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          status = excluded.status,
          repo = excluded.repo,
          issue_identifier = excluded.issue_identifier,
          issue_title = excluded.issue_title,
          policy_rule = excluded.policy_rule,
          policy_decision = excluded.policy_decision,
          updated_at = excluded.updated_at,
          last_message = excluded.last_message,
          retry_eligible = excluded.retry_eligible,
          retry_count = excluded.retry_count,
          failure_reason = null,
          started_at = null,
          completed_at = null,
          canceled_at = null`,
      ).run(
        record.id,
        record.sessionId,
        record.status,
        record.repo,
        record.issueIdentifier ?? null,
        record.issueTitle ?? null,
        record.policyRule,
        record.policyDecision,
        record.createdAt,
        record.updatedAt,
        record.lastMessage,
        0,
        0,
      );
      this.insertEvent("info", `Queued job for ${record.repo}`, record.id, now);
    })();

    return record;
  }

  async updateJob(id: string, status: JobStatus, lastMessage: string, options: JobUpdateOptions = {}): Promise<void> {
    const db = this.requireDb();
    const now = new Date().toISOString();
    const startedAt = status === "running" ? now : null;
    const completedAt = status === "completed" || status === "denied" || status === "waiting_approval" ? now : null;
    const canceledAt = status === "canceled" ? now : null;
    const retryEligible = options.retryEligible === undefined ? null : Number(options.retryEligible);
    const retryIncrement = options.incrementRetryCount ? 1 : 0;
    const failureReason = options.failureReason ?? null;
    const result = db
      .query(
        `update jobs set
          status = ?,
          last_message = ?,
          updated_at = ?,
          started_at = coalesce(started_at, ?),
          completed_at = coalesce(completed_at, ?),
          canceled_at = coalesce(canceled_at, ?),
          retry_eligible = coalesce(?, retry_eligible),
          retry_count = retry_count + ?,
          failure_reason = case when ? is not null then ? else failure_reason end
        where id = ?`,
      )
      .run(
        status,
        lastMessage,
        now,
        startedAt,
        completedAt,
        canceledAt,
        retryEligible,
        retryIncrement,
        failureReason,
        failureReason,
        id,
      );

    if (result.changes === 0) {
      return;
    }

    db.query(
      `update sessions
       set status = case
         when ? in ('completed', 'failed', 'denied', 'canceled') then ?
         else status
       end,
       updated_at = ?
       where id = (select session_id from jobs where id = ?)`,
    ).run(status, status, now, id);
    await this.addEvent(status === "failed" ? "error" : "info", lastMessage, id);
  }

  async setJobWorktree(id: string, worktree: WorktreeInfo): Promise<void> {
    const db = this.requireDb();
    const now = new Date().toISOString();
    const result = db
      .query("update jobs set branch_name = ?, worktree_path = ?, updated_at = ? where id = ?")
      .run(worktree.branchName, worktree.path, now, id);

    if (result.changes === 0) {
      return;
    }

    await this.addEvent("info", `Prepared worktree ${worktree.branchName}`, id);
  }

  async addEvent(level: DaemonEvent["level"], message: string, jobId?: string): Promise<void> {
    this.insertEvent(level, message, jobId, new Date().toISOString());
  }

  private migrate(): void {
    const db = this.requireDb();
    db.exec(`
      create table if not exists daemon_metadata (
        key text primary key,
        value text not null
      );

      create table if not exists repo_mappings (
        id integer primary key autoincrement,
        github text not null unique,
        local_path text not null,
        default_base text not null,
        linear_teams_json text not null,
        test_commands_json text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists sessions (
        id text primary key,
        issue_id text,
        issue_identifier text,
        issue_title text,
        repo text not null,
        codex_thread_id text,
        status text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists jobs (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        status text not null,
        repo text not null,
        branch_name text,
        worktree_path text,
        issue_identifier text,
        issue_title text,
        policy_rule text not null,
        policy_decision text not null,
        created_at text not null,
        updated_at text not null,
        started_at text,
        completed_at text,
        canceled_at text,
        last_message text not null,
        retry_eligible integer not null default 0,
        retry_count integer not null default 0,
        failure_reason text
      );

      create table if not exists job_events (
        id text primary key,
        job_id text references jobs(id) on delete cascade,
        level text not null,
        message text not null,
        created_at text not null
      );

      create table if not exists approvals (
        id text primary key,
        job_id text references jobs(id) on delete cascade,
        requested_action text not null,
        status text not null,
        approver text,
        linear_comment_id text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists pull_requests (
        id text primary key,
        job_id text references jobs(id) on delete cascade,
        github_repo text not null,
        branch_name text not null,
        pr_number integer,
        url text,
        status text not null,
        created_at text not null,
        updated_at text not null
      );

      create index if not exists idx_jobs_updated_at on jobs(updated_at);
      create index if not exists idx_job_events_created_at on job_events(created_at);
      create index if not exists idx_job_events_job_id on job_events(job_id);
    `);
  }

  private ensureStartedAt(): void {
    if (this.getMetadata("started_at", false)) {
      return;
    }

    this.requireDb()
      .query("insert into daemon_metadata (key, value) values (?, ?)")
      .run("started_at", new Date().toISOString());
  }

  private getMetadata(key: string, required = true): string {
    const row = this.requireDb().query("select value from daemon_metadata where key = ?").get(key) as MetadataRow | null;
    if (!row && required) {
      throw new Error(`Missing daemon metadata ${key}`);
    }
    return row?.value ?? "";
  }

  private insertEvent(level: DaemonEvent["level"], message: string, jobId: string | undefined, createdAt: string): void {
    this.requireDb()
      .query("insert into job_events (id, job_id, level, message, created_at) values (?, ?, ?, ?, ?)")
      .run(randomUUID(), jobId ?? null, level, message, createdAt);
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("State store is not loaded");
    }
    return this.db;
  }
}

export function createJobId(sessionId: string): string {
  return `${sessionId}-${randomUUID().slice(0, 8)}`;
}

function jobFromRow(row: JobRow): JobRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    repo: row.repo,
    branchName: row.branch_name ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    issueIdentifier: row.issue_identifier ?? undefined,
    issueTitle: row.issue_title ?? undefined,
    policyRule: row.policy_rule,
    policyDecision: row.policy_decision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    canceledAt: row.canceled_at ?? undefined,
    lastMessage: row.last_message,
    retryEligible: Boolean(row.retry_eligible),
    retryCount: row.retry_count,
    failureReason: row.failure_reason ?? undefined,
  };
}

function eventFromRow(row: EventRow): DaemonEvent {
  return {
    id: row.id,
    jobId: row.job_id ?? undefined,
    level: row.level,
    message: row.message,
    createdAt: row.created_at,
  };
}
