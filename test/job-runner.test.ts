import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runJob } from "../src/job-runner";
import { StateStore } from "../src/state-store";
import type { BridgeConfig, CodexNotification, RoutedJob, SandboxMode } from "../src/types";

describe("runJob", () => {
  test("enforces plan-only policy with a read-only Codex turn and no PR automation", async () => {
    const state = new StateStore(await statePath());
    await state.load();
    await state.createJob(planOnlyJob);
    const client = new FakeCodexClient();
    let preparedWorktree = false;
    let finalizedRun = false;

    const result = await runJob(config, planOnlyJob, state, {
      createClient: () => client,
      prepareWorktree: async () => {
        preparedWorktree = true;
        throw new Error("plan-only should not prepare a worktree");
      },
      finalizeRun: async () => {
        finalizedRun = true;
        throw new Error("plan-only should not finalize a run");
      },
    });

    expect(result).toEqual({
      status: "completed",
      message: "Plan-only Codex turn completed",
    });
    expect(preparedWorktree).toBe(false);
    expect(finalizedRun).toBe(false);
    expect(client.stopped).toBe(true);
    expect(client.turns).toHaveLength(1);
    expect(client.turns[0]).toMatchObject({
      cwd: "/tmp/example",
      sandbox: "read-only",
    });
    expect(client.turns[0]?.input).toContain("Policy mode: plan-only");
    expect(client.turns[0]?.input).toContain("Do not edit files");
    expect(state.getSessionThreadId("session-1")).toBe("thread-plan");
    state.close();
  });

  test("records commit signing warnings without blocking completed jobs", async () => {
    const state = new StateStore(await statePath());
    await state.load();
    await state.createJob(autoJob);
    const client = new FakeCodexClient();

    const result = await runJob(config, autoJob, state, {
      createClient: () => client,
      prepareWorktree: async () => worktree,
      finalizeRun: async () => ({
        status: "no_changes",
        warnings: ["Git signing key not found at /tmp/key; created an unsigned commit."],
      }),
    });
    const event = state.snapshot().events.find((candidate) => candidate.source === "git");
    state.close();

    expect(result).toEqual({
      status: "completed",
      message: "Codex turn completed",
    });
    expect(event).toMatchObject({
      level: "warn",
      message: "Git signing key not found at /tmp/key; created an unsigned commit.",
      jobId: "job-2",
    });
  });
});

async function statePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "tetherbox-job-runner-")), "daemon.sqlite");
}

const config: BridgeConfig = {
  server: { host: "127.0.0.1", port: 8787 },
  linear: { webhookSecretEnv: "LINEAR_WEBHOOK_SECRET" },
  codex: { bin: "codex", sandbox: "workspace-write" },
  repos: [],
  policies: [],
};

const planOnlyJob: RoutedJob = {
  id: "job-1",
  sessionId: "session-1",
  prompt: "Review the authentication changes",
  issue: {
    identifier: "OSS-245",
    title: "Enforce plan-only policy decisions",
    labels: ["security"],
  },
  repo: {
    linearTeams: ["OSS"],
    github: "lucasilverentand/example",
    localPath: "/tmp/example",
    defaultBase: "main",
  },
  policy: {
    ruleName: "security-plan-only",
    decision: "allow_plan_only",
    sandbox: "workspace-write",
  },
};

const autoJob: RoutedJob = {
  ...planOnlyJob,
  id: "job-2",
  policy: {
    ruleName: "docs-auto",
    decision: "allow_auto",
    sandbox: "workspace-write",
  },
};

const worktree = {
  branchName: "oss-233-create-signed-co-authored-commits",
  path: "/tmp/worktree",
};

class FakeCodexClient {
  turns: Array<{
    cwd: string;
    input: string;
    threadId?: string;
    model?: string;
    sandbox: SandboxMode;
    onNotification?: (notification: CodexNotification) => void;
  }> = [];
  stopped = false;

  async runTurn(options: {
    cwd: string;
    input: string;
    threadId?: string;
    model?: string;
    sandbox: SandboxMode;
    onNotification?: (notification: CodexNotification) => void;
  }): Promise<string> {
    this.turns.push(options);
    options.onNotification?.({ method: "turn/completed", params: {} });
    return "thread-plan";
  }

  stop(): void {
    this.stopped = true;
  }
}
