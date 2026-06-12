import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { JobQueue } from "../src/job-queue";
import { runJob } from "../src/job-runner";
import { createRequestHandler } from "../src/server";
import { StateStore } from "../src/state-store";
import type { BridgeConfig, PolicyRule } from "../src/types";

const harnesses: IntegrationHarness[] = [];

afterEach(async () => {
  while (harnesses.length) {
    await harnesses.pop()?.close();
  }
});

describe("local integration harness", () => {
  test("drives a fake Linear webhook through Codex completion without opening a PR", async () => {
    const harness = await createHarness({
      codexScenario: "success",
      policies: [{ name: "docs-auto", labels: ["docs"], decision: "allow_auto" }],
    });

    const response = await harness.sendLinearWebhook(linearCreatedEvent("sess_success", ["docs"]));

    expect(response.status).toBe(200);
    await waitFor(() => harness.jobForSession("sess_success")?.status === "completed");
    const job = harness.jobForSession("sess_success");

    expect(job).toMatchObject({
      status: "completed",
      repo: "lucasilverentand/example",
      policyRule: "docs-auto",
      policyDecision: "allow_auto",
    });
    expect(job?.worktreePath).toContain("tetherbox-integration-");
    expect(harness.pullRequestCount()).toBe(0);
    expect(job?.lastMessage).toBe("Codex turn completed");
  });

  test("simulates Codex App Server failure from the webhook path", async () => {
    const harness = await createHarness({
      codexScenario: "failure",
      policies: [{ name: "docs-auto", labels: ["docs"], decision: "allow_auto" }],
    });

    const response = await harness.sendLinearWebhook(linearCreatedEvent("sess_failure", ["docs"]));

    expect(response.status).toBe(200);
    await waitFor(() => harness.jobForSession("sess_failure")?.status === "failed");
    const job = harness.jobForSession("sess_failure");

    expect(job?.retryEligible).toBe(true);
    expect(job?.retryCount).toBe(1);
    expect(job?.failureReason).toContain("Codex app-server request failed");
  });

  test("keeps approval-required jobs waiting before Codex starts", async () => {
    const harness = await createHarness({
      codexScenario: "success",
      policies: [{ name: "approval-required", labels: ["security"], decision: "require_approval" }],
    });

    const response = await harness.sendLinearWebhook(linearCreatedEvent("sess_approval", ["security"]));

    expect(response.status).toBe(200);
    await waitFor(() => harness.jobForSession("sess_approval")?.status === "waiting_approval");
    const approval = harness.state.getPendingApprovalForSession("sess_approval");

    expect(approval).toMatchObject({
      jobId: harness.jobForSession("sess_approval")?.id,
      requestedAction: "Run local Codex",
      status: "pending",
    });
    expect(approval?.expiresAt).toBeDefined();
    expect(harness.jobForSession("sess_approval")?.worktreePath).toBeUndefined();
  });
});

interface IntegrationHarness {
  state: StateStore;
  sendLinearWebhook(event: unknown): Promise<Response>;
  jobForSession(sessionId: string): ReturnType<StateStore["getJob"]>;
  pullRequestCount(): number;
  close(): Promise<void>;
}

async function createHarness(options: {
  codexScenario: "success" | "failure";
  policies: PolicyRule[];
}): Promise<IntegrationHarness> {
  const root = await mkdtemp(join(tmpdir(), "tetherbox-integration-"));
  const repo = await createRepo(root);
  const codexBin = await fakeCodex(root, options.codexScenario);
  const statePath = join(root, "state", "daemon.sqlite");
  const state = new StateStore(statePath);
  await state.load();

  const config: BridgeConfig = {
    server: { host: "127.0.0.1", port: 8787, publicUrl: "https://bridge.example" },
    state: { path: statePath },
    queue: { concurrency: 1, shutdownGraceMs: 10, approvalTimeoutMs: 60_000 },
    linear: { webhookSecretEnv: "LINEAR_WEBHOOK_SECRET" },
    codex: { bin: codexBin, sandbox: "workspace-write", appServerStartupTimeoutMs: 1_000, turnTimeoutMs: 1_000 },
    repos: [
      {
        linearTeams: ["OSS"],
        github: "lucasilverentand/example",
        localPath: repo,
        defaultBase: "main",
      },
    ],
    policies: options.policies,
  };
  state.syncRepoMappings(config.repos);
  const queue = new JobQueue({
    concurrency: 1,
    state,
    execute: (job, signal) => runJob(config, job, state, { signal }),
  });
  const handler = createRequestHandler({ config, state, queue, webhookSecret: "secret" });
  const harness = {
    state,
    sendLinearWebhook(event: unknown): Promise<Response> {
      const body = JSON.stringify({ webhookTimestamp: Date.now(), ...(event as Record<string, unknown>) });
      return handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );
    },
    jobForSession(sessionId: string) {
      return state.snapshot().jobs.find((job) => job.sessionId === sessionId);
    },
    pullRequestCount(): number {
      const db = new Database(statePath);
      try {
        return Number((db.query("select count(*) as count from pull_requests").get() as { count: number }).count);
      } finally {
        db.close();
      }
    },
    async close(): Promise<void> {
      await queue.shutdown({ graceMs: 1 });
      state.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

function linearCreatedEvent(sessionId: string, labels: string[]): unknown {
  return {
    action: "created",
    agentSession: {
      id: sessionId,
      promptContext: "Inspect the repo and handle the issue.",
      issue: {
        id: `issue-${sessionId}`,
        identifier: "OSS-244",
        title: "Create local integration harness",
        description: "Exercise the daemon path with fake Linear and fake Codex.",
        teamKey: "OSS",
        labels,
        url: "https://linear.app/example/issue/OSS-244/create-end-to-end-local-integration-test-harness",
      },
    },
  };
}

async function createRepo(root: string): Promise<string> {
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const repo = join(root, "repo");
  await git(root, ["init", "--bare", remote]);
  await git(root, ["init", "-b", "main", seed]);
  await git(seed, ["config", "user.email", "test@example.com"]);
  await git(seed, ["config", "user.name", "Tetherbox Test"]);
  await writeFile(join(seed, "README.md"), "# Fixture\n");
  await git(seed, ["add", "README.md"]);
  await git(seed, ["commit", "-m", "initial fixture"]);
  await git(seed, ["remote", "add", "origin", remote]);
  await git(seed, ["push", "origin", "main"]);
  await git(root, ["clone", remote, repo]);
  return repo;
}

async function fakeCodex(root: string, scenario: "success" | "failure"): Promise<string> {
  const bin = join(root, `fake-codex-${scenario}`);
  await writeFile(
    bin,
    `#!/usr/bin/env bun
import { createInterface } from "node:readline";

const scenario = ${JSON.stringify(scenario)};
const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, {});
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start") {
    respond(message.id, { thread: { id: "thread-integration" } });
    return;
  }
  if (message.method === "turn/start") {
    if (scenario === "failure") {
      console.log(JSON.stringify({ id: message.id, error: { message: "fake turn failed" } }));
      return;
    }
    respond(message.id, {});
    console.log(JSON.stringify({ method: "turn/completed", params: {} }));
  }
});

function respond(id, result) {
  console.log(JSON.stringify({ id, result }));
}
`,
  );
  await chmod(bin, 0o755);
  return bin;
}

function signature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 3_000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
