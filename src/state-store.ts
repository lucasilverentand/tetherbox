import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { redact, redactValue } from "./redaction";
import type { DaemonEvent, DaemonState, JobRecord, JobStatus, LinearIssueContext, RepoMapping, RoutedJob } from "./types";
import type { WorktreeInfo } from "./worktree-manager";

interface JobRow {
  id: string;
  session_id: string;
  status: JobStatus;
  repo: string;
  prompt: string | null;
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
  source: string;
  level: DaemonEvent["level"];
  message: string;
  created_at: string;
}

interface MetadataRow {
  value: string;
}

interface SessionThreadRow {
  codex_thread_id: string | null;
}

export interface LinearInstallationRecord {
  workspaceId: string;
  appUserId?: string;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface LinearInstallationRow {
  workspace_id: string;
  app_user_id: string | null;
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  scope: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OAuthStateRow {
  state: string;
  redirect_uri: string;
  expires_at: string;
}

export interface ProcessedWebhookRecord {
  id: string;
  source: string;
  receivedAt: string;
}

export interface PendingApprovalRecord {
  id: string;
  jobId: string;
  requestedAction: string;
  status: "pending" | "approved" | "denied";
  expiresAt?: string;
}

interface PendingApprovalRow {
  id: string;
  job_id: string;
  requested_action: string;
  status: "pending" | "approved" | "denied";
  expires_at: string | null;
}

export interface PendingRepoSelectionRecord {
  id: string;
  sessionId: string;
  jobId: string;
  prompt: string;
  issue: LinearIssueContext;
  status: "pending" | "resolved" | "canceled";
  selectedRepo?: string;
}

interface PendingRepoSelectionRow {
  id: string;
  session_id: string;
  job_id: string;
  prompt: string;
  issue_json: string;
  status: "pending" | "resolved" | "canceled";
  selected_repo: string | null;
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
      .map((row) => jobFromRow(row as JobRow, true));
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

  async createJob(job: RoutedJob, processedWebhookDeliveryId?: string): Promise<JobRecord> {
    const db = this.requireDb();
    const now = new Date().toISOString();
    const record: JobRecord = {
      id: job.id,
      sessionId: job.sessionId,
      status: "queued",
      repo: job.repo.github,
      prompt: job.prompt,
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
          id, issue_id, issue_identifier, issue_title, issue_team_id, repo, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          issue_id = excluded.issue_id,
          issue_identifier = excluded.issue_identifier,
          issue_title = excluded.issue_title,
          issue_team_id = excluded.issue_team_id,
          repo = excluded.repo,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      ).run(
        job.sessionId,
        job.issue.id ?? null,
        job.issue.identifier ?? null,
        job.issue.title ?? null,
        job.issue.teamId ?? null,
        job.repo.github,
        "active",
        now,
        now,
      );
      db.query(
        `insert into jobs (
          id, session_id, status, repo, prompt, issue_identifier, issue_title, policy_rule,
          policy_decision, created_at, updated_at, last_message, retry_eligible, retry_count
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          status = excluded.status,
          repo = excluded.repo,
          prompt = excluded.prompt,
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
        job.prompt,
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
      if (processedWebhookDeliveryId) {
        this.insertProcessedWebhookDelivery(processedWebhookDeliveryId, "linear", now);
      }
      this.insertEvent("queue", "info", `Queued job for ${record.repo}`, record.id, now);
    })();

    return record;
  }

  async updateJob(id: string, status: JobStatus, lastMessage: string, options: JobUpdateOptions = {}): Promise<void> {
    const db = this.requireDb();
    const now = new Date().toISOString();
    const startedAt = status === "running" ? now : null;
    const completedAt = status === "completed" || status === "denied" ? now : null;
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
    await this.addEvent(status === "failed" ? "error" : "info", lastMessage, id, "job");
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

    await this.addEvent("info", `Prepared worktree ${worktree.branchName}`, id, "worktree");
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.requireDb().query("select * from jobs where id = ?").get(id) as JobRow | null;
    return row ? jobFromRow(row) : undefined;
  }

  getActiveJobForSession(sessionId: string): JobRecord | undefined {
    const row = this.requireDb()
      .query(
        `select * from jobs
         where session_id = ? and status in ('queued', 'running', 'waiting_approval')
         order by updated_at desc, created_at desc
         limit 1`,
      )
      .get(sessionId) as JobRow | null;
    return row ? jobFromRow(row) : undefined;
  }

  listActiveJobsForIssue(issue: Pick<LinearIssueContext, "id" | "identifier">): JobRecord[] {
    if (!issue.id && !issue.identifier) {
      return [];
    }

    return (
      this.requireDb()
        .query(
          `select jobs.* from jobs
           inner join sessions on sessions.id = jobs.session_id
           where jobs.status in ('queued', 'running', 'waiting_approval')
             and (
               (? is not null and sessions.issue_id = ?)
               or (? is not null and jobs.issue_identifier = ?)
               or (? is not null and jobs.issue_identifier = ?)
             )
           order by jobs.updated_at desc, jobs.created_at desc`,
        )
        .all(
          issue.id ?? null,
          issue.id ?? null,
          issue.identifier ?? null,
          issue.identifier ?? null,
          issue.id ?? null,
          issue.id ?? null,
        ) as JobRow[]
    ).map((row) => jobFromRow(row));
  }

  listActiveJobsForTeamIds(teamIds: readonly string[]): JobRecord[] {
    const normalized = [...new Set(teamIds.map((teamId) => teamId.trim()).filter(Boolean))];
    if (!normalized.length) {
      return [];
    }

    const placeholders = normalized.map(() => "?").join(", ");
    return (
      this.requireDb()
        .query(
          `select jobs.* from jobs
           inner join sessions on sessions.id = jobs.session_id
           where jobs.status in ('queued', 'running', 'waiting_approval')
             and sessions.issue_team_id in (${placeholders})
           order by jobs.updated_at desc, jobs.created_at desc`,
        )
        .all(...normalized) as JobRow[]
    ).map((row) => jobFromRow(row));
  }

  createApproval(jobId: string, requestedAction: string, expiresAt?: string): PendingApprovalRecord {
    const now = new Date().toISOString();
    const id = `${jobId}:approval`;
    this.requireDb()
      .query(
        `insert into approvals (
          id, job_id, requested_action, status, expires_at, created_at, updated_at
        ) values (?, ?, ?, 'pending', ?, ?, ?)
        on conflict(id) do update set
          requested_action = excluded.requested_action,
          status = 'pending',
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at`,
      )
      .run(id, jobId, requestedAction, expiresAt ?? null, now, now);
    return { id, jobId, requestedAction, status: "pending", expiresAt };
  }

  getPendingApprovalForSession(sessionId: string): PendingApprovalRecord | undefined {
    const row = this.requireDb()
      .query(
        `select approvals.id, approvals.job_id, approvals.requested_action, approvals.status, approvals.expires_at
         from approvals
         inner join jobs on jobs.id = approvals.job_id
         where jobs.session_id = ? and approvals.status = 'pending'
         order by approvals.updated_at desc
         limit 1`,
      )
      .get(sessionId) as PendingApprovalRow | null;

    return row
      ? {
          id: row.id,
          jobId: row.job_id,
          requestedAction: row.requested_action,
          status: row.status,
          expiresAt: row.expires_at ?? undefined,
        }
      : undefined;
  }

  getPendingApprovalForJob(jobId: string): PendingApprovalRecord | undefined {
    const row = this.requireDb()
      .query(
        `select id, job_id, requested_action, status, expires_at
         from approvals
         where job_id = ? and status = 'pending'
         order by updated_at desc
         limit 1`,
      )
      .get(jobId) as PendingApprovalRow | null;

    return row ? pendingApprovalFromRow(row) : undefined;
  }

  listPendingApprovals(): PendingApprovalRecord[] {
    return (
      this.requireDb()
        .query("select id, job_id, requested_action, status, expires_at from approvals where status = 'pending'")
        .all() as PendingApprovalRow[]
    ).map(pendingApprovalFromRow);
  }

  expirePendingApproval(jobId: string, now = new Date()): PendingApprovalRecord | undefined {
    const pending = this.getPendingApprovalForJob(jobId);
    if (!pending?.expiresAt || Date.parse(pending.expiresAt) > now.getTime()) {
      return undefined;
    }

    this.resolveApproval(pending.id, "denied", "timeout");
    return pending;
  }

  resolveApproval(id: string, status: "approved" | "denied", approver?: string): void {
    this.requireDb()
      .query("update approvals set status = ?, approver = ?, updated_at = ? where id = ?")
      .run(status, approver ?? null, new Date().toISOString(), id);
  }

  createRepoSelection(
    job: Pick<RoutedJob, "id" | "sessionId" | "prompt" | "issue">,
    processedWebhookDeliveryId?: string,
  ): PendingRepoSelectionRecord {
    const db = this.requireDb();
    const now = new Date().toISOString();
    const id = `${job.sessionId}:repo-selection`;
    const issueJson = JSON.stringify(job.issue);
    db.transaction(() => {
      db.query(
        `insert into sessions (
          id, issue_id, issue_identifier, issue_title, repo, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, 'awaiting_repo', ?, ?)
        on conflict(id) do update set
          issue_id = excluded.issue_id,
          issue_identifier = excluded.issue_identifier,
          issue_title = excluded.issue_title,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      ).run(
        job.sessionId,
        job.issue.id ?? null,
        job.issue.identifier ?? null,
        job.issue.title ?? null,
        "",
        now,
        now,
      );
      db.query(
        `insert into repo_selections (
          id, session_id, job_id, prompt, issue_json, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, 'pending', ?, ?)
        on conflict(id) do update set
          job_id = excluded.job_id,
          prompt = excluded.prompt,
          issue_json = excluded.issue_json,
          status = 'pending',
          selected_repo = null,
          updated_at = excluded.updated_at`,
      ).run(id, job.sessionId, job.id, job.prompt, issueJson, now, now);
      if (processedWebhookDeliveryId) {
        this.insertProcessedWebhookDelivery(processedWebhookDeliveryId, "linear", now);
      }
    })();

    return {
      id,
      sessionId: job.sessionId,
      jobId: job.id,
      prompt: job.prompt,
      issue: job.issue,
      status: "pending",
    };
  }

  getPendingRepoSelectionForSession(sessionId: string): PendingRepoSelectionRecord | undefined {
    const row = this.requireDb()
      .query(
        `select * from repo_selections
         where session_id = ? and status = 'pending'
         order by updated_at desc
         limit 1`,
      )
      .get(sessionId) as PendingRepoSelectionRow | null;
    return row ? repoSelectionFromRow(row) : undefined;
  }

  resolveRepoSelection(id: string, status: "resolved" | "canceled", selectedRepo?: string): void {
    this.requireDb()
      .query("update repo_selections set status = ?, selected_repo = ?, updated_at = ? where id = ?")
      .run(status, selectedRepo ?? null, new Date().toISOString(), id);
  }

  getSessionThreadId(sessionId: string): string | undefined {
    const row = this.requireDb()
      .query("select codex_thread_id from sessions where id = ?")
      .get(sessionId) as SessionThreadRow | null;
    return row?.codex_thread_id ?? undefined;
  }

  async setSessionThreadId(sessionId: string, threadId: string, jobId?: string): Promise<void> {
    const now = new Date().toISOString();
    const result = this.requireDb()
      .query("update sessions set codex_thread_id = ?, updated_at = ? where id = ?")
      .run(threadId, now, sessionId);

    if (result.changes > 0) {
      await this.addEvent("info", `Linked Linear session to Codex thread ${threadId}`, jobId, "codex");
    }
  }

  createLinearOAuthState(state: string, redirectUri: string, expiresAt: string): void {
    const now = new Date().toISOString();
    this.requireDb()
      .query(
        `insert into linear_oauth_states (state, redirect_uri, expires_at, created_at)
         values (?, ?, ?, ?)`,
      )
      .run(state, redirectUri, expiresAt, now);
  }

  consumeLinearOAuthState(state: string, now = new Date()): { redirectUri: string } | undefined {
    const db = this.requireDb();
    const row = db
      .query("select state, redirect_uri, expires_at from linear_oauth_states where state = ?")
      .get(state) as OAuthStateRow | null;
    db.query("delete from linear_oauth_states where state = ?").run(state);

    if (!row || Date.parse(row.expires_at) <= now.getTime()) {
      return undefined;
    }

    return { redirectUri: row.redirect_uri };
  }

  saveLinearInstallation(record: {
    workspaceId: string;
    appUserId?: string;
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    scope?: string;
    expiresAt?: string;
  }): void {
    const now = new Date().toISOString();
    this.requireDb()
      .query(
        `insert into workspace_installations (
          workspace_id, app_user_id, access_token, refresh_token, token_type, scope, expires_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(workspace_id) do update set
          app_user_id = excluded.app_user_id,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          token_type = excluded.token_type,
          scope = excluded.scope,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.workspaceId,
        record.appUserId ?? null,
        record.accessToken,
        record.refreshToken ?? null,
        record.tokenType ?? "Bearer",
        record.scope ?? "",
        record.expiresAt ?? null,
        now,
        now,
      );
  }

  getLinearInstallation(workspaceId = "default"): LinearInstallationRecord | undefined {
    const row = this.requireDb()
      .query("select * from workspace_installations where workspace_id = ?")
      .get(workspaceId) as LinearInstallationRow | null;
    return row ? linearInstallationFromRow(row) : undefined;
  }

  deleteLinearInstallation(workspaceId = "default"): void {
    this.requireDb().query("delete from workspace_installations where workspace_id = ?").run(workspaceId);
  }

  claimWebhookDelivery(id: string, source = "linear"): boolean {
    const now = new Date().toISOString();
    const result = this.insertProcessedWebhookDelivery(id, source, now);
    return result.changes > 0;
  }

  getProcessedWebhook(id: string): ProcessedWebhookRecord | undefined {
    const row = this.requireDb()
      .query("select id, source, received_at from processed_webhooks where id = ?")
      .get(id) as { id: string; source: string; received_at: string } | null;
    return row ? { id: row.id, source: row.source, receivedAt: row.received_at } : undefined;
  }

  savePullRequest(record: {
    jobId: string;
    githubRepo: string;
    branchName: string;
    prNumber?: number;
    url?: string;
    status: string;
  }): void {
    const now = new Date().toISOString();
    this.requireDb()
      .query(
        `insert into pull_requests (
          id, job_id, github_repo, branch_name, pr_number, url, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          pr_number = excluded.pr_number,
          url = excluded.url,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(
        `${record.githubRepo}:${record.branchName}`,
        record.jobId,
        record.githubRepo,
        record.branchName,
        record.prNumber ?? null,
        record.url ?? null,
        record.status,
        now,
        now,
      );
  }

  async addEvent(level: DaemonEvent["level"], message: string, jobId?: string, source = "daemon"): Promise<void> {
    this.insertEvent(source, level, message, jobId, new Date().toISOString());
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

      create table if not exists workspace_installations (
        workspace_id text primary key,
        app_user_id text,
        access_token text not null,
        refresh_token text,
        token_type text not null,
        scope text not null,
        expires_at text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists linear_oauth_states (
        state text primary key,
        redirect_uri text not null,
        expires_at text not null,
        created_at text not null
      );

      create table if not exists processed_webhooks (
        id text primary key,
        source text not null,
        received_at text not null
      );

      create table if not exists sessions (
        id text primary key,
        issue_id text,
        issue_identifier text,
        issue_title text,
        issue_team_id text,
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
        prompt text,
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
        source text not null default 'daemon',
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
        expires_at text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists repo_selections (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        job_id text not null,
        prompt text not null,
        issue_json text not null,
        status text not null,
        selected_repo text,
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
      create index if not exists idx_processed_webhooks_received_at on processed_webhooks(received_at);
    `);
    this.addColumnIfMissing("jobs", "prompt", "text");
    this.addColumnIfMissing("sessions", "issue_team_id", "text");
    this.addColumnIfMissing("approvals", "expires_at", "text");
    this.addColumnIfMissing("job_events", "source", "text not null default 'daemon'");
  }

  private insertProcessedWebhookDelivery(id: string, source: string, receivedAt: string): { changes: number } {
    return this.requireDb()
      .query("insert into processed_webhooks (id, source, received_at) values (?, ?, ?) on conflict(id) do nothing")
      .run(id, source, receivedAt);
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

  private insertEvent(
    source: string,
    level: DaemonEvent["level"],
    message: string,
    jobId: string | undefined,
    createdAt: string,
  ): void {
    this.requireDb()
      .query("insert into job_events (id, job_id, source, level, message, created_at) values (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), jobId ?? null, redact(source), level, redact(message), createdAt);
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("State store is not loaded");
    }
    return this.db;
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    try {
      this.requireDb().exec(`alter table ${table} add column ${column} ${definition}`);
    } catch (error) {
      if (!String(error).includes("duplicate column name")) {
        throw error;
      }
    }
  }
}

function pendingApprovalFromRow(row: PendingApprovalRow): PendingApprovalRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    requestedAction: row.requested_action,
    status: row.status,
    expiresAt: row.expires_at ?? undefined,
  };
}

export function createJobId(sessionId: string): string {
  return `${sessionId}-${randomUUID().slice(0, 8)}`;
}

function jobFromRow(row: JobRow, redactForOutput = false): JobRecord {
  const record = {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    repo: row.repo,
    prompt: row.prompt ?? undefined,
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
  return redactForOutput ? redactValue(record) : record;
}

function eventFromRow(row: EventRow): DaemonEvent {
  return {
    id: row.id,
    jobId: row.job_id ?? undefined,
    source: row.source,
    level: row.level,
    message: row.message,
    createdAt: row.created_at,
  };
}

function repoSelectionFromRow(row: PendingRepoSelectionRow): PendingRepoSelectionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    jobId: row.job_id,
    prompt: row.prompt,
    issue: JSON.parse(row.issue_json) as LinearIssueContext,
    status: row.status,
    selectedRepo: row.selected_repo ?? undefined,
  };
}

function linearInstallationFromRow(row: LinearInstallationRow): LinearInstallationRecord {
  return {
    workspaceId: row.workspace_id,
    appUserId: row.app_user_id ?? undefined,
    accessToken: row.access_token,
    refreshToken: row.refresh_token ?? undefined,
    tokenType: row.token_type,
    scope: row.scope,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
