import { loadConfig, getRequiredEnv } from "./config";
import { assertSupportedCodexCli } from "./codex-version";
import {
  getIssueContext,
  getPrompt,
  getSessionId,
  buildLinearOAuthAuthorizationUrl,
  completeLinearOAuthCallback,
  parseLinearAgentEvent,
  postLinearActivity,
  statusExternalUrl,
  updateLinearAgentSession,
  verifyLinearSignature,
} from "./linear";
import { applyPolicy } from "./policy";
import { routeRepoForSession } from "./repo-router";
import { runJob } from "./job-runner";
import { JobQueue } from "./job-queue";
import { createJobId, StateStore } from "./state-store";
import type { BridgeConfig, RoutedJob } from "./types";

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
      const sessionId = getSessionId(event);
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
  queue: Pick<JobQueue, "enqueue">;
  event: ReturnType<typeof parseLinearAgentEvent>;
  sessionId: string;
  jobId: string;
}

async function intakeLinearWebhook(options: LinearWebhookIntakeOptions): Promise<void> {
  const { config, state, queue, event, sessionId, jobId } = options;
  const issue = getIssueContext(event);
  const prompt = getPrompt(event);
  const externalUrl = statusExternalUrl(config, jobId);

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
    const policy = applyPolicy(config, issue, repo);
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
  jobId: string,
): Promise<void> {
  try {
    await postLinearActivity(config, sessionId, content, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post Linear activity";
    await state.addEvent("warn", message, jobId);
  }
}
