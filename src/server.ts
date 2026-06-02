import { loadConfig, getRequiredEnv } from "./config";
import { assertSupportedCodexCli } from "./codex-version";
import {
  buildLinearJobPrompt,
  formatLinearInboxNotificationWebhookEvent,
  formatLinearManagementWebhookEvent,
  getAgentSessionAction,
  getIssueContext,
  getLinearInboxNotificationWebhook,
  getPrompt,
  getSessionId,
  getLinearManagementWebhook,
  buildLinearOAuthAuthorizationUrl,
  completeLinearOAuthCallback,
  isStopSignal,
  listLinearAgentSessionActivities,
  parseApprovalDecision,
  parseLinearAgentEvent,
  postLinearActivity,
  statusExternalUrl,
  syncLinearIssueForAgentSession,
  updateLinearAgentSession,
  verifyLinearSignature,
} from "./linear";
import { applyPolicy } from "./policy";
import { findExplicitRepo, routeRepoForSession } from "./repo-router";
import { runJob } from "./job-runner";
import { JobQueue } from "./job-queue";
import { createJobId, StateStore } from "./state-store";
import type { BridgeConfig, JobRecord, RepoMapping, RoutedJob } from "./types";

export async function serve(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  await assertSupportedCodexCli(config.codex.bin, config.codex.minSupportedVersion);
  const webhookSecret = getRequiredEnv(config.linear.webhookSecretEnv);
  const state = new StateStore(config.state?.path ?? "state/daemon.sqlite");
  await state.load();
  state.syncRepoMappings(config.repos);
  const queue = new JobQueue({
    concurrency: config.queue?.concurrency ?? 1,
    state,
    execute: (job, signal) => runJob(config, job, state, { signal }),
  });

  const server = Bun.serve({
    hostname: config.server.host,
    port: config.server.port,
    fetch: createRequestHandler({ config, state, queue, webhookSecret }),
  });

  const shutdown = async () => {
    console.log("tetherbox shutting down");
    await queue.shutdown({ graceMs: config.queue?.shutdownGraceMs ?? 30_000 });
    state.close();
    server.stop(true);
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  console.log(`tetherbox listening on http://${server.hostname}:${server.port}`);
}

export interface RequestHandlerOptions {
  config: BridgeConfig;
  state: StateStore;
  queue: Pick<JobQueue, "cancel" | "enqueue" | "stats">;
  webhookSecret: string;
}

export function createRequestHandler(options: RequestHandlerOptions): (request: Request) => Promise<Response> {
  const { config, state, queue, webhookSecret } = options;

  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, startedAt: state.snapshot().startedAt });
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      return Response.json(state.snapshot(queue.stats()));
    }

    if (request.method === "GET" && url.pathname === "/oauth/linear/start") {
      try {
        return Response.redirect(buildLinearOAuthAuthorizationUrl(config, state), 302);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Linear OAuth start failed";
        return Response.json({ error: message }, { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/oauth/linear/callback") {
      try {
        const installation = await completeLinearOAuthCallback(config, state, url.searchParams);
        return Response.json({
          ok: true,
          workspaceId: installation.workspaceId,
          appUserId: installation.appUserId,
          scope: installation.scope,
          expiresAt: installation.expiresAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Linear OAuth callback failed";
        return Response.json({ error: message }, { status: 400 });
      }
    }

    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      if (!isOperatorRequest(config, request, url)) {
        return Response.json({ ok: false, reason: "operator_auth_required" }, { status: 401 });
      }
      const canceled = await queue.cancel(decodeURIComponent(cancelMatch[1]!));
      return Response.json({ ok: canceled });
    }

    const retryMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
    if (request.method === "POST" && retryMatch) {
      if (!isOperatorRequest(config, request, url)) {
        return Response.json({ ok: false, reason: "operator_auth_required" }, { status: 401 });
      }
      const result = await retryJobFromApi(config, state, queue, decodeURIComponent(retryMatch[1]!));
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }

    const approveMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/approve$/);
    if (request.method === "POST" && approveMatch) {
      if (!isOperatorRequest(config, request, url)) {
        return Response.json({ ok: false, reason: "operator_auth_required" }, { status: 401 });
      }
      const result = await resolveApprovalFromApi(config, state, queue, decodeURIComponent(approveMatch[1]!), "approved");
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }

    const denyMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/deny$/);
    if (request.method === "POST" && denyMatch) {
      if (!isOperatorRequest(config, request, url)) {
        return Response.json({ ok: false, reason: "operator_auth_required" }, { status: 401 });
      }
      const result = await resolveApprovalFromApi(config, state, queue, decodeURIComponent(denyMatch[1]!), "denied");
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }

    if (request.method !== "POST" || url.pathname !== "/webhooks/linear") {
      return new Response("Not found", { status: 404 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("Linear-Signature");

    if (!verifyLinearSignature(rawBody, signature, webhookSecret)) {
      return Response.json({ error: "Invalid Linear signature" }, { status: 401 });
    }

    try {
      const event = parseLinearAgentEvent(rawBody);
      const managementWebhook = getLinearManagementWebhook(event);
      if (managementWebhook) {
        await handleLinearManagementWebhook(state, managementWebhook);
        return Response.json({
          ok: true,
          accepted: true,
          eventType: managementWebhook.type,
          action: managementWebhook.action,
        });
      }

      const inboxNotification = getLinearInboxNotificationWebhook(event);
      if (inboxNotification) {
        const canceledJobIds = await handleLinearInboxNotificationWebhook(state, queue, inboxNotification);
        return Response.json({
          ok: true,
          accepted: true,
          eventType: inboxNotification.type,
          action: inboxNotification.action,
          canceledJobIds,
        });
      }

      const action = getAgentSessionAction(event);
      if (!action) {
        const reason = `Ignored unsupported Linear AgentSessionEvent action: ${event.action ?? "missing"}`;
        await state.addEvent("warn", reason, undefined, "linear");
        return Response.json({
          ok: true,
          accepted: false,
          reason: "unsupported_action",
          action: event.action ?? null,
        });
      }
      const sessionId = getSessionId(event);
      if (action === "prompted" && isStopSignal(event)) {
        void handleLinearStopSignal({ config, state, queue, sessionId }).catch((error) => {
          console.error("Linear stop signal handling failed", error);
        });
        return Response.json({ ok: true, accepted: true, sessionId, stop: true });
      }
      const jobId = createJobId(sessionId);
      void intakeLinearWebhook({ config, state, queue, event, sessionId, jobId }).catch((error) => {
        console.error("Linear webhook intake failed", error);
      });
      return Response.json({ ok: true, accepted: true, sessionId, jobId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unhandled webhook error";
      return Response.json({ error: message }, { status: 400 });
    }
  };
}

async function handleLinearManagementWebhook(
  state: StateStore,
  event: NonNullable<ReturnType<typeof getLinearManagementWebhook>>,
): Promise<void> {
  if (event.type === "OAuthApp" && event.action === "revoked") {
    state.deleteLinearInstallation();
    await state.addEvent("warn", formatLinearManagementWebhookEvent(event), undefined, "linear");
    return;
  }

  await state.addEvent("info", formatLinearManagementWebhookEvent(event), undefined, "linear");
}

async function handleLinearInboxNotificationWebhook(
  state: StateStore,
  queue: Pick<JobQueue, "cancel">,
  event: NonNullable<ReturnType<typeof getLinearInboxNotificationWebhook>>,
): Promise<string[]> {
  await state.addEvent("info", formatLinearInboxNotificationWebhookEvent(event), undefined, "linear");
  if (event.action !== "issueUnassignedFromYou" || !event.issue) {
    return [];
  }

  const activeJobs = state.listActiveJobsForIssue(event.issue);
  const canceledJobIds: string[] = [];
  for (const job of activeJobs) {
    const pendingApproval = state.getPendingApprovalForJob(job.id);
    if (pendingApproval) {
      state.resolveApproval(pendingApproval.id, "denied", "Linear unassignment");
    }

    const canceledByQueue = await queue.cancel(job.id);
    if (!canceledByQueue || job.status === "waiting_approval") {
      await state.updateJob(job.id, "canceled", "Canceled because the Linear app user was unassigned from the issue", {
        retryEligible: false,
        failureReason: "Linear app user unassigned from issue",
      });
    }
    await state.addEvent("warn", "Canceled job because the Linear app user was unassigned from the issue", job.id, "linear");
    canceledJobIds.push(job.id);
  }

  if (!canceledJobIds.length) {
    await state.addEvent("warn", "Linear app user was unassigned from an issue, but no matching active job was found", undefined, "linear");
  }
  return canceledJobIds;
}

function isOperatorRequest(config: BridgeConfig, request: Request, url: URL): boolean {
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") {
    return true;
  }

  const tokenEnv = config.server.operatorTokenEnv;
  const expected = tokenEnv ? process.env[tokenEnv] : undefined;
  if (!expected) {
    return false;
  }

  const authorization = request.headers.get("Authorization");
  const headerToken = request.headers.get("X-Tetherbox-Operator-Token");
  return authorization === `Bearer ${expected}` || headerToken === expected;
}

async function retryJobFromApi(
  config: BridgeConfig,
  state: StateStore,
  queue: Pick<JobQueue, "enqueue">,
  jobId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const record = state.getJob(jobId);
  if (!record) {
    return { ok: false, reason: "job_not_found" };
  }
  if (!record.retryEligible) {
    return { ok: false, reason: "job_not_retry_eligible" };
  }

  const routed = routedJobFromRecord(config, record, record.policyDecision);
  if (!routed) {
    return { ok: false, reason: "repo_not_configured" };
  }

  await state.updateJob(record.id, "queued", "Retry queued from TUI", { retryEligible: false });
  await state.addEvent("info", "Retry queued from TUI", record.id, "tui");
  queue.enqueue(routed);
  return { ok: true };
}

async function resolveApprovalFromApi(
  config: BridgeConfig,
  state: StateStore,
  queue: Pick<JobQueue, "enqueue">,
  jobId: string,
  status: "approved" | "denied",
): Promise<{ ok: boolean; reason?: string }> {
  const record = state.getJob(jobId);
  const approval = state.getPendingApprovalForJob(jobId);
  if (!record || !approval) {
    return { ok: false, reason: "pending_approval_not_found" };
  }

  state.resolveApproval(approval.id, status, "TUI");
  if (status === "denied") {
    await state.updateJob(record.id, "canceled", "Denied from TUI", { retryEligible: false });
    await state.addEvent("warn", "Approval denied from TUI", record.id, "tui");
    return { ok: true };
  }

  const routed = routedJobFromRecord(config, record, "allow_auto");
  if (!routed) {
    await state.updateJob(record.id, "failed", `Could not approve job; repo ${record.repo} is not configured`, {
      retryEligible: false,
    });
    return { ok: false, reason: "repo_not_configured" };
  }

  await state.updateJob(record.id, "queued", "Approved from TUI; queued for local Codex", { retryEligible: false });
  await state.addEvent("info", "Approval granted from TUI", record.id, "tui");
  queue.enqueue(routed);
  return { ok: true };
}

function routedJobFromRecord(
  config: BridgeConfig,
  record: JobRecord,
  decision: RoutedJob["policy"]["decision"],
): RoutedJob | undefined {
  const repo = config.repos.find((candidate) => candidate.github === record.repo);
  if (!repo) {
    return undefined;
  }

  return {
    id: record.id,
    sessionId: record.sessionId,
    prompt: record.prompt ?? "",
    issue: {
      identifier: record.issueIdentifier,
      title: record.issueTitle,
      labels: [],
    },
    repo,
    policy: {
      ruleName: decision === "allow_auto" ? `${record.policyRule}:tui` : record.policyRule,
      decision,
      sandbox: config.codex.sandbox,
    },
  };
}

interface LinearWebhookIntakeOptions {
  config: BridgeConfig;
  state: StateStore;
  queue: Pick<JobQueue, "cancel" | "enqueue">;
  event: ReturnType<typeof parseLinearAgentEvent>;
  sessionId: string;
  jobId: string;
}

async function intakeLinearWebhook(options: LinearWebhookIntakeOptions): Promise<void> {
  const { config, state, queue, event, sessionId, jobId } = options;
  const issue = getIssueContext(event);
  const replyPrompt = getPrompt(event);
  const externalUrl = statusExternalUrl(config, jobId);
  const handledApproval = await maybeHandleApprovalReply({
    config,
    state,
    queue,
    sessionId,
    prompt: replyPrompt,
  });
  if (handledApproval) {
    return;
  }
  const handledRepoSelection = await maybeHandleRepoSelectionReply({
    config,
    state,
    queue,
    event,
    sessionId,
    prompt: replyPrompt,
  });
  if (handledRepoSelection) {
    return;
  }

  await safeUpdateLinearAgentSession(config, state, sessionId, {
    ...(externalUrl ? { addedExternalUrls: [externalUrl] } : {}),
    plan: [
      { content: "Acknowledge Linear session", status: "completed" },
      { content: "Route Linear context to a local repository", status: "inProgress" },
      { content: "Run Codex locally in an isolated worktree", status: "pending" },
      { content: "Report the result back to Linear", status: "pending" },
    ],
  }, undefined);
  await safePostLinearActivity(config, state, sessionId, {
    type: "thought",
    body: `Received Linear session ${sessionId}; routing local job ${jobId}.`,
  }, undefined);
  await safeSyncLinearIssueLifecycle(config, state, issue);

  let prompt = buildLinearJobPrompt(event);
  try {
    const activities = await safeListLinearAgentSessionActivities(config, state, sessionId);
    prompt = buildLinearJobPrompt(event, activities);
    const repo = await routeRepoForSession(config, issue, prompt, sessionId, state);
    const policy = applyPolicy(config, issue, repo, { prompt });
    const job: RoutedJob = { id: jobId, sessionId, prompt, issue, repo, policy };
    await state.createJob(job);
    await safeUpdateLinearAgentSession(config, state, sessionId, {
      ...(externalUrl ? { addedExternalUrls: [externalUrl] } : {}),
      plan: [
        { content: "Acknowledge Linear session", status: "completed" },
        { content: "Route Linear context to a local repository", status: "completed" },
        { content: "Run Codex locally in an isolated worktree", status: "pending" },
        { content: "Report the result back to Linear", status: "pending" },
      ],
    }, jobId);
    await safePostLinearActivity(config, state, sessionId, {
      type: "thought",
      body: `Queued local Tetherbox job ${job.id} for ${repo.github}.`,
    }, jobId);
    queue.enqueue(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Linear webhook intake failed";
    if (message === "Could not route Linear issue to a local repository") {
      state.createRepoSelection({ id: jobId, sessionId, prompt, issue });
      await safeUpdateLinearAgentSession(config, state, sessionId, {
        plan: [
          { content: "Acknowledge Linear session", status: "completed" },
          { content: "Route Linear context to a local repository", status: "inProgress" },
          { content: "Run Codex locally in an isolated worktree", status: "pending" },
          { content: "Report the result back to Linear", status: "pending" },
        ],
      }, undefined);
      await postRepoSelection(config, state, sessionId, config.repos);
      return;
    }
    await state.addEvent("error", message, undefined, "linear");
    await safeUpdateLinearAgentSession(config, state, sessionId, {
      plan: [
        { content: "Acknowledge Linear session", status: "completed" },
        { content: "Route Linear context to a local repository", status: "canceled" },
        { content: "Run Codex locally in an isolated worktree", status: "canceled" },
        { content: "Report the result back to Linear", status: "completed" },
      ],
    }, undefined);
    await safePostLinearActivity(config, state, sessionId, {
      type: "error",
      body: `Could not queue local job: ${message}`,
    }, undefined);
  }
}

async function handleLinearStopSignal(options: {
  config: BridgeConfig;
  state: StateStore;
  queue: Pick<JobQueue, "cancel">;
  sessionId: string;
}): Promise<void> {
  const { config, state, queue, sessionId } = options;
  const activeJob = state.getActiveJobForSession(sessionId);
  if (!activeJob) {
    await state.addEvent(
      "warn",
      `Stop signal received for Linear session ${sessionId}, but no active job was found`,
      undefined,
      "linear",
    );
    await safePostLinearActivity(config, state, sessionId, {
      type: "response",
      body: "No active local Codex job was running.",
    });
    return;
  }

  const pendingApproval = state.getPendingApprovalForSession(sessionId);
  if (pendingApproval?.jobId === activeJob.id) {
    state.resolveApproval(pendingApproval.id, "denied");
  }

  const canceledByQueue = await queue.cancel(activeJob.id);
  if (!canceledByQueue || activeJob.status === "waiting_approval") {
    await state.updateJob(activeJob.id, "canceled", "Canceled by Linear stop signal");
  }
  await safePostLinearActivity(config, state, sessionId, {
    type: "response",
    body: "Stopped the local Codex run.",
  }, activeJob.id);
}

async function maybeHandleRepoSelectionReply(options: {
  config: BridgeConfig;
  state: StateStore;
  queue: Pick<JobQueue, "enqueue">;
  event: ReturnType<typeof parseLinearAgentEvent>;
  sessionId: string;
  prompt: string;
}): Promise<boolean> {
  const { config, state, queue, event, sessionId, prompt } = options;
  const pending = state.getPendingRepoSelectionForSession(sessionId);
  if (!pending) {
    return false;
  }

  const selectedRepo = repoFromSelectionReply(config, event, prompt);
  if (!selectedRepo) {
    await postRepoSelection(config, state, sessionId, config.repos, pending.jobId);
    return true;
  }

  state.resolveRepoSelection(pending.id, "resolved", selectedRepo.github);
  const policy = applyPolicy(config, pending.issue, selectedRepo, { prompt: pending.prompt });
  const job: RoutedJob = {
    id: pending.jobId,
    sessionId,
    prompt: pending.prompt,
    issue: pending.issue,
    repo: selectedRepo,
    policy,
  };
  await state.createJob(job);
  await safeUpdateLinearAgentSession(config, state, sessionId, {
    plan: [
      { content: "Acknowledge Linear session", status: "completed" },
      { content: "Route Linear context to a local repository", status: "completed" },
      { content: "Run Codex locally in an isolated worktree", status: "pending" },
      { content: "Report the result back to Linear", status: "pending" },
    ],
  }, pending.jobId);
  await safePostLinearActivity(config, state, sessionId, {
    type: "thought",
    body: `Queued local Tetherbox job ${job.id} for ${selectedRepo.github}.`,
  }, pending.jobId);
  queue.enqueue(job);
  return true;
}

async function postRepoSelection(
  config: BridgeConfig,
  state: StateStore,
  sessionId: string,
  repos: RepoMapping[],
): Promise<void> {
  await safePostLinearActivity(config, state, sessionId, {
    content: {
      type: "elicitation",
      body: "Select the repository Tetherbox should use for this local Codex run.",
    },
    signal: "select",
    signalMetadata: {
      options: repos.map((repo) => ({
        label: repo.github,
        value: repo.github,
      })),
    },
  }, undefined);
}

function repoFromSelectionReply(
  config: BridgeConfig,
  event: ReturnType<typeof parseLinearAgentEvent>,
  prompt: string,
): RepoMapping | undefined {
  const selected = selectionValue(event);
  if (selected) {
    const byValue = config.repos.find((repo) => repo.github.toLowerCase() === selected.toLowerCase());
    if (byValue) {
      return byValue;
    }
  }

  return findExplicitRepo(config.repos, prompt);
}

function selectionValue(event: ReturnType<typeof parseLinearAgentEvent>): string | undefined {
  const metadata = event.agentActivity?.signalMetadata ?? event.agentActivity?.content?.signalMetadata;
  if (typeof metadata === "string") {
    return metadata;
  }
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const record = metadata as Record<string, unknown>;
    for (const key of ["value", "repositoryFullName", "repo", "repository"]) {
      if (typeof record[key] === "string") {
        return record[key];
      }
    }
  }
  return undefined;
}

async function maybeHandleApprovalReply(options: {
  config: BridgeConfig;
  state: StateStore;
  queue: Pick<JobQueue, "enqueue">;
  sessionId: string;
  prompt: string;
}): Promise<boolean> {
  const { config, state, queue, sessionId, prompt } = options;
  const pending = state.getPendingApprovalForSession(sessionId);
  if (!pending) {
    return false;
  }

  const decision = parseApprovalDecision(prompt);
  if (!decision) {
    await safePostLinearActivity(config, state, sessionId, {
      type: "elicitation",
      body: "Please reply `approve` to continue or `deny` to cancel this local Codex run.",
    }, pending.jobId);
    return true;
  }

  const record = state.getJob(pending.jobId);
  if (!record) {
    state.resolveApproval(pending.id, "denied");
    await state.addEvent("error", "Approval target job no longer exists", pending.jobId, "approval");
    return true;
  }

  if (decision === "deny") {
    state.resolveApproval(pending.id, "denied");
    await state.updateJob(record.id, "canceled", "Canceled by Linear approval reply");
    await safePostLinearActivity(config, state, sessionId, {
      type: "response",
      body: "Canceled the local Codex run.",
    }, record.id);
    return true;
  }

  const repo = config.repos.find((candidate) => candidate.github === record.repo);
  if (!repo) {
    state.resolveApproval(pending.id, "denied");
    await state.updateJob(record.id, "failed", `Could not resume approved job; repo ${record.repo} is not configured`, {
      failureReason: "Missing repo mapping for approved job",
      retryEligible: false,
    });
    return true;
  }

  state.resolveApproval(pending.id, "approved");
  await state.updateJob(record.id, "queued", "Approved in Linear; queued for local Codex");
  await safePostLinearActivity(config, state, sessionId, {
    type: "thought",
    body: "Approval received. Continuing the local Codex run.",
  }, record.id);
  queue.enqueue({
    id: record.id,
    sessionId: record.sessionId,
    prompt: record.prompt ?? prompt,
    issue: {
      identifier: record.issueIdentifier,
      title: record.issueTitle,
      labels: [],
    },
    repo,
    policy: {
      ruleName: `${record.policyRule}:approved`,
      decision: "allow_auto",
      sandbox: config.codex.sandbox,
    },
  });
  return true;
}

async function safeUpdateLinearAgentSession(
  config: BridgeConfig,
  state: StateStore,
  sessionId: string,
  input: Parameters<typeof updateLinearAgentSession>[2],
  jobId: string,
): Promise<void> {
  try {
    await updateLinearAgentSession(config, sessionId, input, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update Linear agent session";
    await state.addEvent("warn", message, jobId, "linear");
  }
}

async function safePostLinearActivity(
  config: BridgeConfig,
  state: StateStore,
  sessionId: string,
  content: Parameters<typeof postLinearActivity>[2],
  jobId?: string,
): Promise<void> {
  try {
    await postLinearActivity(config, sessionId, content, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post Linear activity";
    await state.addEvent("warn", message, jobId, "linear");
  }
}

async function safeSyncLinearIssueLifecycle(
  config: BridgeConfig,
  state: StateStore,
  issue: ReturnType<typeof getIssueContext>,
): Promise<void> {
  try {
    const result = await syncLinearIssueForAgentSession(config, issue, state);
    if (result.movedToState || result.delegateSet) {
      await state.addEvent(
        "info",
        [
          result.movedToState ? `Moved Linear issue to ${result.movedToState}` : undefined,
          result.delegateSet ? "Set Tetherbox app user as Linear delegate" : undefined,
        ]
        .filter(Boolean)
        .join("; "),
        undefined,
        "linear",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to sync Linear issue lifecycle";
    await state.addEvent("warn", message, undefined, "linear");
  }
}

async function safeListLinearAgentSessionActivities(
  config: BridgeConfig,
  state: StateStore,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof listLinearAgentSessionActivities>>> {
  try {
    const activities = await listLinearAgentSessionActivities(config, sessionId, state);
    if (activities.length) {
      await state.addEvent("info", `Fetched ${activities.length} Linear Agent Session activities`, undefined, "linear");
    }
    return activities;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch Linear Agent Session activities";
    await state.addEvent("warn", message, undefined, "linear");
    return [];
  }
}
