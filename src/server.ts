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
    async fetch(request) {
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
        const issue = getIssueContext(event);
        const prompt = getPrompt(event);
        const sessionId = getSessionId(event);
        const repo = await routeRepoForSession(config, issue, prompt, sessionId, state);
        const policy = applyPolicy(config, issue, repo);

        const job = { id: createJobId(sessionId), sessionId, prompt, issue, repo, policy };
        await state.createJob(job);
        const externalUrl = statusExternalUrl(config, job.id);
        void updateLinearAgentSession(config, sessionId, {
          ...(externalUrl ? { externalUrls: [externalUrl] } : {}),
          plan: [
            { content: "Route Linear context to a local repository", status: "completed" },
            { content: "Run Codex locally in an isolated worktree", status: "pending" },
            { content: "Report the result back to Linear", status: "pending" },
          ],
        }, state).catch((error) => {
          console.error("Failed to update Linear agent session", error);
        });
        void postLinearActivity(config, sessionId, {
          type: "thought",
          body: `Queued local Tetherbox job ${job.id} for ${repo.github}.`,
        }, state).catch((error) => {
          console.error("Failed to post Linear activity", error);
        });
        queue.enqueue(job);

        return Response.json({ ok: true, queued: true, sessionId, jobId: job.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unhandled webhook error";
        return Response.json({ error: message }, { status: 400 });
      }
    },
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
