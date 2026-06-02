import { loadConfig, getRequiredEnv } from "./config";
import { getIssueContext, getPrompt, getSessionId, parseLinearAgentEvent, verifyLinearSignature } from "./linear";
import { applyPolicy } from "./policy";
import { routeRepo } from "./repo-router";
import { runJob } from "./job-runner";

export async function serve(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  const webhookSecret = getRequiredEnv(config.linear.webhookSecretEnv);

  const server = Bun.serve({
    hostname: config.server.host,
    port: config.server.port,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ ok: true });
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

        const job = { sessionId, prompt, issue, repo, policy };
        queueMicrotask(() => {
          runJob(config, job).catch((error) => {
            console.error("Job failed", error);
          });
        });

        return Response.json({ ok: true, queued: true, sessionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unhandled webhook error";
        return Response.json({ error: message }, { status: 400 });
      }
    },
  });

  console.log(`local-linear-codex-bridge listening on http://${server.hostname}:${server.port}`);
}
