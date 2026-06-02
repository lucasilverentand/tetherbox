import { loadConfig, getRequiredEnv } from "./config";
import { getIssueContext, getPrompt, getSessionId, parseLinearAgentEvent, verifyLinearSignature } from "./linear";
import { applyPolicy } from "./policy";
import { routeRepo } from "./repo-router";
import { runJob } from "./job-runner";
import { JobQueue } from "./job-queue";
import { createJobId, StateStore } from "./state-store";

export async function serve(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
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
        const repo = routeRepo(config, issue, prompt);
        const policy = applyPolicy(config, issue, repo);

        const job = { id: createJobId(sessionId), sessionId, prompt, issue, repo, policy };
        await state.createJob(job);
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
