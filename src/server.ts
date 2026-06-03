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
  linearWorkspaceIdForEvent,
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
  type LinearInboxNotificationWebhook,
} from "./linear";
import { applyPolicy } from "./policy";
import { findExplicitRepo, routeRepoForSession } from "./repo-router";
import { runJob } from "./job-runner";
import { JobQueue } from "./job-queue";
import { createJobId, StateStore } from "./state-store";
import { renderWebUi } from "./web-ui";
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

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderWebUi(state.snapshot(queue.stats())), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
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
      const timestampError = linearWebhookTimestampError(event, config.linear.webhookMaxAgeMs);
      if (timestampError) {
        await state.addEvent("warn", timestampError.message, undefined, "linear");
        return Response.json({ error: timestampError.message, reason: timestampError.reason }, { status: 401 });
      }
      const deliveryId = linearWebhookDeliveryId(event, request.headers.get("Linear-Delivery"));
      const linearWorkspaceId = linearWorkspaceIdForEvent(event);
      const managementWebhook = getLinearManagementWebhook(event);
      if (managementWebhook) {
        if (deliveryId && !state.claimWebhookDelivery(deliveryId)) {
          return duplicateLinearWebhookResponse(state, deliveryId);
        }
        const canceledJobIds = await handleLinearManagementWebhook(state, queue, managementWebhook, linearWorkspaceId);
        return Response.json({
          ok: true,
          accepted: true,
          eventType: managementWebhook.type,
          action: managementWebhook.action,
          canceledJobIds,
        });
      }

      const inboxNotification = getLinearInboxNotificationWebhook(event);
      if (inboxNotification) {
        if (deliveryId && !state.claimWebhookDelivery(deliveryId)) {
          return duplicateLinearWebhookResponse(state, deliveryId);
        }
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
        if (deliveryId && state.getProcessedWebhook(deliveryId)) {
          return duplicateLinearWebhookResponse(state, deliveryId);
        }
        const reason = `Ignored unsupported Linear AgentSessionEvent action: ${event.action ?? "missing"}`;
        await state.addEvent("warn", reason, undefined, "linear");
        if (deliveryId) {
          state.claimWebhookDelivery(deliveryId);
        }
        return Response.json({
          ok: true,
          accepted: false,
          reason: "unsupported_action",
          action: event.action ?? null,
        });
      }
      const sessionId = getSessionId(event);
      if (deliveryId && state.getProcessedWebhook(deliveryId)) {
        return duplicateLinearWebhookResponse(state, deliveryId);
      }
      if (action === "prompted" && isStopSignal(event)) {
        void handleLinearStopSignal({ config, state, queue, sessionId, linearWorkspaceId, deliveryId }).catch((error) => {
          console.error("Linear stop signal handling failed", error);
        });
        return Response.json({ ok: true, accepted: true, sessionId, stop: true });
      }
      const jobId = createJobId(sessionId);
      void intakeLinearWebhook({ config, state, queue, event, sessionId, jobId, linearWorkspaceId, deliveryId }).catch((error) => {
        console.error("Linear webhook intake failed", error);
      });
      return Response.json({ ok: true, accepted: true, sessionId, jobId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unhandled webhook error";
      return Response.json({ error: message }, { status: 400 });
    }
  };
}

const DEFAULT_LINEAR_WEBHOOK_MAX_AGE_MS = 60_000;

function linearWebhookTimestampError(
  event: { webhookTimestamp?: unknown },
  maxAgeMs = DEFAULT_LINEAR_WEBHOOK_MAX_AGE_MS,
  now = Date.now(),
): { reason: "missing_webhook_timestamp" | "invalid_webhook_timestamp" | "stale_webhook"; message: string } | undefined {
  const timestamp = event.webhookTimestamp;
  if (timestamp === undefined || timestamp === null) {
    return {
      reason: "missing_webhook_timestamp",
      message: "Linear webhook missing webhookTimestamp",
    };
  }
  if (!Number.isFinite(timestamp) || typeof timestamp !== "number") {
    return {
      reason: "invalid_webhook_timestamp",
      message: "Linear webhook has invalid webhookTimestamp",
    };
  }
  if (Math.abs(now - timestamp) > maxAgeMs) {
    return {
      reason: "stale_webhook",
      message: "Linear webhook timestamp is outside the accepted freshness window",
    };
  }
  return undefined;
}

async function duplicateLinearWebhookResponse(state: StateStore, deliveryId: string): Promise<Response> {
  await state.addEvent("info", `Ignored duplicate Linear webhook delivery ${deliveryId}`, undefined, "linear");
  return Response.json({
    ok: true,
    accepted: false,
    reason: "duplicate_webhook",
    deliveryId,
  });
}

function linearWebhookDeliveryId(event: { webhookId?: unknown }, headerDeliveryId: string | null): string | undefined {
  return firstNonEmptyString(event.webhookId, headerDeliveryId);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

async function handleLinearManagementWebhook(
  state: StateStore,
  queue: Pick<JobQueue, "cancel">,
  event: NonNullable<ReturnType<typeof getLinearManagementWebhook>>,
  linearWorkspaceId?: string,
): Promise<string[]> {
  if (event.type === "OAuthApp" && event.action === "revoked") {
    state.deleteLinearInstallation(linearWorkspaceId ?? "default");
    await state.addEvent("warn", formatLinearManagementWebhookEvent(event), undefined, "linear");
    return [];
  }

  await state.addEvent("info", formatLinearManagementWebhookEvent(event), undefined, "linear");
  if (!event.removedTeamIds.length) {
    return [];
  }

  return cancelActiveJobsForLinearTeamIds(state, queue, event.removedTeamIds, {
    approvalResolution: "Linear team access removed",
    jobMessage: "Canceled because Linear removed app access to the issue team",
    failureReason: "Linear app access removed for issue team",
    eventMessage: "Canceled job because Linear removed app access to the issue team",
  });
}

async function handleLinearInboxNotificationWebhook(
  state: StateStore,
  queue: Pick<JobQueue, "cancel">,
  event: NonNullable<ReturnType<typeof getLinearInboxNotificationWebhook>>,
): Promise<string[]> {
  await state.addEvent("info", formatLinearInboxNotificationWebhookEvent(event), undefined, "linear");
  if (!event.issue) {
    return [];
  }

  if (event.action === "issueUnassignedFromYou") {
    return cancelActiveJobsForLinearIssue(state, queue, event.issue, {
      approvalResolution: "Linear unassignment",
      jobMessage: "Canceled because the Linear app user was unassigned from the issue",
      failureReason: "Linear app user unassigned from issue",
      eventMessage: "Canceled job because the Linear app user was unassigned from the issue",
      noMatchMessage: "Linear app user was unassigned from an issue, but no matching active job was found",
    });
  }

  if (event.action === "issueStatusChanged") {
    const terminalStatus = terminalLinearIssueStatusType(event.issue.statusType);
    if (terminalStatus) {
      return cancelActiveJobsForLinearIssue(state, queue, event.issue, {
        approvalResolution: "Linear issue status changed",
        jobMessage: `Canceled because the Linear issue moved to ${terminalStatus}`,
        failureReason: `Linear issue status changed to ${terminalStatus}`,
        eventMessage: `Canceled job because the Linear issue moved to ${terminalStatus}`,
        noMatchMessage: `Linear issue moved to ${terminalStatus}, but no matching active job was found`,
      });
    }
  }

  if (shouldAttachLinearInboxNotificationToActiveJobs(event)) {
    await attachLinearInboxNotificationToActiveJobs(state, event);
  }

  return [];
}

function shouldAttachLinearInboxNotificationToActiveJobs(event: LinearInboxNotificationWebhook): boolean {
  return (
    event.action === "issueMention" ||
    event.action === "issueCommentMention" ||
    event.action === "issueNewComment" ||
    event.action === "issueAssignedToYou" ||
    event.action === "issueEmojiReaction" ||
    event.action === "issueCommentReaction"
  );
}

async function attachLinearInboxNotificationToActiveJobs(
  state: StateStore,
  event: LinearInboxNotificationWebhook,
): Promise<void> {
  if (!event.issue) {
    return;
  }

  const activeJobs = state.listActiveJobsForIssue(event.issue);
  if (!activeJobs.length) {
    return;
  }

  const message = formatLinearInboxNotificationWebhookEvent(event);
  for (const job of activeJobs) {
    await state.addEvent("info", message, job.id, "linear");
  }
}

function terminalLinearIssueStatusType(statusType: string | undefined): "completed" | "canceled" | undefined {
  const normalized = statusType?.trim().toLowerCase();
  return normalized === "completed" || normalized === "canceled" ? normalized : undefined;
}

async function cancelActiveJobsForLinearIssue(
  state: StateStore,
  queue: Pick<JobQueue, "cancel">,
  issue: NonNullable<LinearInboxNotificationWebhook["issue"]>,
  messages: {
    approvalResolution: string;
    jobMessage: string;
    failureReason: string;
    eventMessage: string;
    noMatchMessage?: string;
  },
): Promise<string[]> {
  const activeJobs = state.listActiveJobsForIssue(issue);
  return cancelActiveLinearJobs(state, queue, activeJobs, messages);
}

async function cancelActiveJobsForLinearTeamIds(
  state: StateStore,
  queue: Pick<JobQueue, "cancel">,
  teamIds: readonly string[],
  messages: {
    approvalResolution: string;
    jobMessage: string;
    failureReason: string;
    eventMessage: string;
    noMatchMessage?: string;
  },
): Promise<string[]> {
  const activeJobs = state.listActiveJobsForTeamIds(teamIds);
  return cancelActiveLinearJobs(state, queue, activeJobs, messages);
}

async function cancelActiveLinearJobs(
  state: StateStore,
  queue: Pick<JobQueue, "cancel">,
  activeJobs: JobRecord[],
  messages: {
    approvalResolution: string;
    jobMessage: string;
    failureReason: string;
    eventMessage: string;
    noMatchMessage?: string;
  },
): Promise<string[]> {
  const canceledJobIds: string[] = [];
  for (const job of activeJobs) {
    const pendingApproval = state.getPendingApprovalForJob(job.id);
    if (pendingApproval) {
      state.resolveApproval(pendingApproval.id, "denied", messages.approvalResolution);
    }

    await queue.cancel(job.id);
    await state.updateJob(job.id, "canceled", messages.jobMessage, {
      retryEligible: false,
      failureReason: messages.failureReason,
    });
    await state.addEvent("warn", messages.eventMessage, job.id, "linear");
    canceledJobIds.push(job.id);
  }

  if (!canceledJobIds.length && messages.noMatchMessage) {
    await state.addEvent("warn", messages.noMatchMessage, undefined, "linear");
  }
  return canceledJobIds;
}

function isOperatorRequest(config: BridgeConfig, request: Request, _url: URL): boolean {
  if (isLoopbackHost(config.server.host)) {
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

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
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
    linearWorkspaceId: record.linearWorkspaceId,
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
  linearWorkspaceId?: string;
  deliveryId?: string;
}

async function intakeLinearWebhook(options: LinearWebhookIntakeOptions): Promise<void> {
  const { config, state, queue, event, sessionId, jobId, linearWorkspaceId, deliveryId } = options;
  const issue = getIssueContext(event);
  const replyPrompt = getPrompt(event);
  const externalUrl = statusExternalUrl(config, jobId);
  const handledApproval = await maybeHandleApprovalReply({
    config,
    state,
    queue,
    sessionId,
    prompt: replyPrompt,
    linearWorkspaceId,
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
    linearWorkspaceId,
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
  }, undefined, linearWorkspaceId);
  await safePostLinearActivity(config, state, sessionId, {
    content: {
      type: "thought",
      body: `Received Linear session ${sessionId}; routing local job ${jobId}.`,
    },
    ephemeral: true,
  }, undefined, linearWorkspaceId);
  await safeSyncLinearIssueLifecycle(config, state, issue, linearWorkspaceId);

  let prompt = buildLinearJobPrompt(event);
  try {
    const activities = await safeListLinearAgentSessionActivities(config, state, sessionId, linearWorkspaceId);
    prompt = buildLinearJobPrompt(event, activities);
    const repo = await routeRepoForSession(config, issue, prompt, sessionId, state, linearWorkspaceId);
    const policy = applyPolicy(config, issue, repo, { prompt });
    const job: RoutedJob = { id: jobId, sessionId, linearWorkspaceId, prompt, issue, repo, policy };
    await state.createJob(job, deliveryId);
    await safeUpdateLinearAgentSession(config, state, sessionId, {
      plan: [
        { content: "Acknowledge Linear session", status: "completed" },
        { content: "Route Linear context to a local repository", status: "completed" },
        { content: "Run Codex locally in an isolated worktree", status: "pending" },
        { content: "Report the result back to Linear", status: "pending" },
      ],
    }, jobId, linearWorkspaceId);
    await safePostLinearActivity(config, state, sessionId, {
      content: {
        type: "thought",
        body: `Queued local Tetherbox job ${job.id} for ${repo.github}.`,
      },
      ephemeral: true,
    }, jobId, linearWorkspaceId);
    queue.enqueue(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Linear webhook intake failed";
    if (message === "Could not route Linear issue to a local repository") {
      state.createRepoSelection({ id: jobId, sessionId, linearWorkspaceId, prompt, issue }, deliveryId);
      await safeUpdateLinearAgentSession(config, state, sessionId, {
        plan: [
          { content: "Acknowledge Linear session", status: "completed" },
          { content: "Route Linear context to a local repository", status: "inProgress" },
          { content: "Run Codex locally in an isolated worktree", status: "pending" },
          { content: "Report the result back to Linear", status: "pending" },
        ],
      }, undefined, linearWorkspaceId);
      await postRepoSelection(config, state, sessionId, config.repos, jobId, linearWorkspaceId);
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
    }, undefined, linearWorkspaceId);
    await safePostLinearActivity(config, state, sessionId, {
      type: "error",
      body: `Could not queue local job: ${message}`,
    }, undefined, linearWorkspaceId);
  }
}

async function handleLinearStopSignal(options: {
  config: BridgeConfig;
  state: StateStore;
  queue: Pick<JobQueue, "cancel">;
  sessionId: string;
  linearWorkspaceId?: string;
  deliveryId?: string;
}): Promise<void> {
  const { config, state, queue, sessionId, linearWorkspaceId, deliveryId } = options;
  const activeJob = state.getActiveJobForSession(sessionId);
  if (!activeJob) {
    await state.addEvent(
      "warn",
      `Stop signal received for Linear session ${sessionId}, but no active job was found`,
      undefined,
      "linear",
    );
    if (deliveryId) {
      state.claimWebhookDelivery(deliveryId);
    }
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
  await safeUpdateLinearAgentSession(config, state, sessionId, {
    plan: [
      { content: "Route Linear context to a local repository", status: "completed" },
      { content: "Run Codex locally", status: "canceled" },
      { content: "Report the result back to Linear", status: "completed" },
    ],
  }, activeJob.id, activeJob.linearWorkspaceId ?? linearWorkspaceId);
  await safePostLinearActivity(config, state, sessionId, {
    type: "error",
    body: "Stopped the local Codex run.",
  }, activeJob.id, activeJob.linearWorkspaceId ?? linearWorkspaceId);
  if (deliveryId) {
    state.claimWebhookDelivery(deliveryId);
  }
}

async function maybeHandleRepoSelectionReply(options: {
  config: BridgeConfig;
  state: StateStore;
  queue: Pick<JobQueue, "enqueue">;
  event: ReturnType<typeof parseLinearAgentEvent>;
  sessionId: string;
  prompt: string;
  linearWorkspaceId?: string;
}): Promise<boolean> {
  const { config, state, queue, event, sessionId, prompt, linearWorkspaceId } = options;
  const pending = state.getPendingRepoSelectionForSession(sessionId);
  if (!pending) {
    return false;
  }

  const selectedRepo = repoFromSelectionReply(config, event, prompt);
  if (!selectedRepo) {
    await postRepoSelection(config, state, sessionId, config.repos, pending.jobId, pending.linearWorkspaceId ?? linearWorkspaceId);
    return true;
  }

  state.resolveRepoSelection(pending.id, "resolved", selectedRepo.github);
  const policy = applyPolicy(config, pending.issue, selectedRepo, { prompt: pending.prompt });
  const jobLinearWorkspaceId = pending.linearWorkspaceId ?? linearWorkspaceId;
  const job: RoutedJob = {
    id: pending.jobId,
    sessionId,
    linearWorkspaceId: jobLinearWorkspaceId,
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
  }, pending.jobId, jobLinearWorkspaceId);
  await safePostLinearActivity(config, state, sessionId, {
    content: {
      type: "thought",
      body: `Queued local Tetherbox job ${job.id} for ${selectedRepo.github}.`,
    },
    ephemeral: true,
  }, pending.jobId, jobLinearWorkspaceId);
  queue.enqueue(job);
  return true;
}

async function postRepoSelection(
  config: BridgeConfig,
  state: StateStore,
  sessionId: string,
  repos: RepoMapping[],
  jobId?: string,
  linearWorkspaceId?: string,
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
  }, jobId, linearWorkspaceId);
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
    const bySelectedText = repoFromSelectionText(config.repos, selected);
    if (bySelectedText) {
      return bySelectedText;
    }
  }

  return repoFromSelectionText(config.repos, prompt) ?? findExplicitRepo(config.repos, prompt);
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

function repoFromSelectionText(repos: RepoMapping[], text: string): RepoMapping | undefined {
  const normalized = text.toLowerCase();
  const fullNameMatches = repos.filter((repo) => textMentionsFullRepoName(normalized, repo.github));
  if (fullNameMatches.length === 1) {
    return fullNameMatches[0];
  }
  if (fullNameMatches.length > 1) {
    return undefined;
  }

  const repoNameMatches = repos.filter((repo) => textMentionsRepoName(normalized, repo.github.split("/").at(-1) ?? repo.github));
  return repoNameMatches.length === 1 ? repoNameMatches[0] : undefined;
}

function textMentionsFullRepoName(normalizedText: string, repoFullName: string): boolean {
  const normalizedRepo = repoFullName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9._-])${normalizedRepo}([^a-z0-9._-]|$)`, "i").test(normalizedText);
}

function textMentionsRepoName(normalizedText: string, repoName: string): boolean {
  const normalizedRepo = repoName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9._-])${normalizedRepo}([^a-z0-9._-]|$)`, "i").test(normalizedText);
}

async function maybeHandleApprovalReply(options: {
  config: BridgeConfig;
  state: StateStore;
  queue: Pick<JobQueue, "enqueue">;
  sessionId: string;
  prompt: string;
  linearWorkspaceId?: string;
}): Promise<boolean> {
  const { config, state, queue, sessionId, prompt, linearWorkspaceId } = options;
  const pending = state.getPendingApprovalForSession(sessionId);
  if (!pending) {
    return false;
  }

  const decision = parseApprovalDecision(prompt);
  if (!decision) {
    await safePostLinearActivity(config, state, sessionId, {
      type: "elicitation",
      body: "Please reply `approve` to continue or `deny` to cancel this local Codex run.",
    }, pending.jobId, linearWorkspaceId);
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
    }, record.id, record.linearWorkspaceId ?? linearWorkspaceId);
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
  }, record.id, record.linearWorkspaceId ?? linearWorkspaceId);
  queue.enqueue({
    id: record.id,
    sessionId: record.sessionId,
    linearWorkspaceId: record.linearWorkspaceId ?? linearWorkspaceId,
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
  linearWorkspaceId?: string,
): Promise<void> {
  try {
    await updateLinearAgentSession(config, sessionId, input, state, linearWorkspaceId);
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
  linearWorkspaceId?: string,
): Promise<void> {
  try {
    await postLinearActivity(config, sessionId, content, state, linearWorkspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post Linear activity";
    await state.addEvent("warn", message, jobId, "linear");
  }
}

async function safeSyncLinearIssueLifecycle(
  config: BridgeConfig,
  state: StateStore,
  issue: ReturnType<typeof getIssueContext>,
  linearWorkspaceId?: string,
): Promise<void> {
  try {
    const result = await syncLinearIssueForAgentSession(config, issue, state, linearWorkspaceId);
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
  linearWorkspaceId?: string,
): Promise<Awaited<ReturnType<typeof listLinearAgentSessionActivities>>> {
  try {
    const activities = await listLinearAgentSessionActivities(config, sessionId, state, 25, linearWorkspaceId);
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
