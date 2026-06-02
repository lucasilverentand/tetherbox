import { loadConfig, getRequiredEnv } from "./config";
import { assertSupportedCodexCli } from "./codex-version";
import {
  buildLinearJobPrompt,
  getAgentSessionAction,
  getIssueContext,
  getPrompt,
  getSessionId,
  buildLinearOAuthAuthorizationUrl,
  completeLinearOAuthCallback,
  isStopSignal,
  parseApprovalDecision,
  parseLinearAgentEvent,
  postLinearActivity,
  statusExternalUrl,
  updateLinearAgentSession,
  verifyLinearSignature,
} from "./linear";
import { applyPolicy } from "./policy";
import { findExplicitRepo, routeRepoForSession } from "./repo-router";
import { runJob } from "./job-runner";
import { JobQueue } from "./job-queue";
import { createJobId, StateStore } from "./state-store";
import type { BridgeConfig, RepoMapping, RoutedJob } from "./types";

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
      const canceled = await queue.cancel(decodeURIComponent(cancelMatch[1]!));
      return Response.json({ ok: canceled });
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
      const action = getAgentSessionAction(event);
      if (!action) {
        const reason = `Ignored unsupported Linear AgentSessionEvent action: ${event.action ?? "missing"}`;
        await state.addEvent("warn", reason);
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
  const prompt = buildLinearJobPrompt(event);
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
    ...(externalUrl ? { externalUrls: [externalUrl] } : {}),
    plan: [
      { content: "Acknowledge Linear session", status: "completed" },
      { content: "Route Linear context to a local repository", status: "inProgress" },
      { content: "Run Codex locally in an isolated worktree", status: "pending" },
      { content: "Report the result back to Linear", status: "pending" },
    ],
  }, jobId);
  await safePostLinearActivity(config, state, sessionId, {
    type: "thought",
    body: `Received Linear session ${sessionId}; routing local job ${jobId}.`,
  }, jobId);

  try {
    const repo = await routeRepoForSession(config, issue, prompt, sessionId, state);
    const policy = applyPolicy(config, issue, repo, { prompt });
    const job: RoutedJob = { id: jobId, sessionId, prompt, issue, repo, policy };
    await state.createJob(job);
    await safeUpdateLinearAgentSession(config, state, sessionId, {
      ...(externalUrl ? { externalUrls: [externalUrl] } : {}),
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
      }, jobId);
      await postRepoSelection(config, state, sessionId, config.repos, jobId);
      return;
    }
    await state.addEvent("error", message, jobId);
    await safeUpdateLinearAgentSession(config, state, sessionId, {
      plan: [
        { content: "Acknowledge Linear session", status: "completed" },
        { content: "Route Linear context to a local repository", status: "canceled" },
        { content: "Run Codex locally in an isolated worktree", status: "canceled" },
        { content: "Report the result back to Linear", status: "completed" },
      ],
    }, jobId);
    await safePostLinearActivity(config, state, sessionId, {
      type: "error",
      body: `Could not queue local job: ${message}`,
    }, jobId);
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
    await state.addEvent("warn", `Stop signal received for Linear session ${sessionId}, but no active job was found`);
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
  jobId: string,
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
  }, jobId);
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
    await state.addEvent("error", "Approval target job no longer exists", pending.jobId);
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
    await state.addEvent("warn", message, jobId);
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
    await state.addEvent("warn", message, jobId);
  }
}
