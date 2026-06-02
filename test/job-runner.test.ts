import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runJob } from "../src/job-runner";
import { GitHubAuthenticationRequiredError, ValidationFailedError } from "../src/pr-automation";
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

  test("records validation failures before failing jobs", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const calls: unknown[] = [];
    const restore = mockFetch(calls);
    const state = new StateStore(await statePath());
    await state.load();
    await state.createJob(autoJob);
    const client = new FakeCodexClient();

    try {
      await expect(
        runJob(
          { ...config, linear: { ...config.linear, apiKeyEnv: "LINEAR_API_KEY" } },
          autoJob,
          state,
          {
            createClient: () => client,
            prepareWorktree: async () => worktree,
            finalizeRun: async () => {
              throw new ValidationFailedError([
                {
                  command: "bun test",
                  status: "failed",
                  stdout: "",
                  stderr: "expected true to be false",
                  summary: "expected true to be false",
                },
              ]);
            },
          },
        ),
      ).rejects.toThrow("Validation command failed: bun test");
      const event = state.snapshot().events.find((candidate) => candidate.source === "validation");

      expect(event).toMatchObject({
        level: "error",
        message: "Validation failed: bun test\nexpected true to be false",
        jobId: "job-2",
      });
      expect(calls).toContainEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            variables: expect.objectContaining({
              input: expect.objectContaining({
                content: {
                  type: "action",
                  action: "Validation failed",
                  parameter: "bun test",
                  result: "expected true to be false",
                },
              }),
            }),
          }),
        }),
      );
    } finally {
      restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("posts passing validation results to Linear activities", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const calls: unknown[] = [];
    const restore = mockFetch(calls);
    const state = new StateStore(await statePath());
    await state.load();
    await state.createJob(autoJob);
    const client = new FakeCodexClient();

    try {
      const result = await runJob(
        { ...config, linear: { ...config.linear, apiKeyEnv: "LINEAR_API_KEY" } },
        autoJob,
        state,
        {
          createClient: () => client,
          prepareWorktree: async () => worktree,
          finalizeRun: async () => ({
            status: "no_changes",
            validation: [
              {
                command: "bun test",
                status: "passed",
                stdout: "2 pass",
                stderr: "",
                summary: "2 pass",
              },
            ],
          }),
        },
      );
      const event = state.snapshot().events.find((candidate) => candidate.source === "validation");

      expect(result).toEqual({
        status: "completed",
        message: "Codex turn completed",
      });
      expect(event).toMatchObject({
        level: "info",
        message: "Validation passed: bun test\n2 pass",
        jobId: "job-2",
      });
      expect(calls).toContainEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            variables: expect.objectContaining({
              input: expect.objectContaining({
                content: {
                  type: "action",
                  action: "Validation passed",
                  parameter: "bun test",
                  result: "2 pass",
                },
              }),
            }),
          }),
        }),
      );
    } finally {
      restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("pauses with a Linear auth signal when GitHub authentication is required", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const calls: unknown[] = [];
    const restore = mockFetch(calls);
    const state = new StateStore(await statePath());
    await state.load();
    await state.createJob(autoJob);
    const client = new FakeCodexClient();

    try {
      const result = await runJob(
        {
          ...config,
          linear: { ...config.linear, apiKeyEnv: "LINEAR_API_KEY" },
          git: { githubAuthUrl: "https://github.com/login/device" },
        },
        autoJob,
        state,
        {
          createClient: () => client,
          prepareWorktree: async () => worktree,
          finalizeRun: async () => {
            throw new GitHubAuthenticationRequiredError("GitHub CLI authentication is required", {
              stdout: "",
              stderr: "gh auth login",
            });
          },
        },
      );

      expect(result).toEqual({
        status: "waiting_approval",
        message: "Waiting for GitHub authentication",
      });
      expect(state.getPendingApprovalForJob("job-2")).toMatchObject({
        requestedAction: "Authenticate GitHub CLI and resume Tetherbox",
        status: "pending",
      });
      expect(state.snapshot().events).toContainEqual(
        expect.objectContaining({
          source: "github",
          level: "warn",
          jobId: "job-2",
          message: "GitHub CLI authentication is required before publishing a pull request",
        }),
      );
      expect(calls).toContainEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            variables: expect.objectContaining({
              input: expect.objectContaining({
                signal: "auth",
                signalMetadata: {
                  url: "https://github.com/login/device",
                  providerName: "GitHub",
                },
                content: expect.objectContaining({
                  type: "elicitation",
                  body: expect.stringContaining("gh auth login"),
                }),
              }),
            }),
          }),
        }),
      );
    } finally {
      restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("adds pull request URLs to the Linear agent session", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const calls: unknown[] = [];
    const restore = mockFetch(calls);
    const state = new StateStore(await statePath());
    await state.load();
    await state.createJob(autoJob);
    const client = new FakeCodexClient();

    try {
      const result = await runJob(
        {
          ...config,
          server: { ...config.server, publicUrl: "https://bridge.example" },
          linear: { ...config.linear, apiKeyEnv: "LINEAR_API_KEY" },
        },
        autoJob,
        state,
        {
          createClient: () => client,
          prepareWorktree: async () => worktree,
          finalizeRun: async () => ({
            status: "created",
            url: "https://github.com/lucasilverentand/example/pull/12",
            number: 12,
          }),
          watchChecks: async () => ({
            status: "no_checks",
            summary: "No GitHub checks were reported for the pull request.",
            output: "no checks reported",
          }),
        },
      );

      expect(result).toEqual({
        status: "completed",
        message: "Codex turn completed",
      });
      expect(calls).toContainEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            variables: expect.objectContaining({
              id: "session-1",
              input: {
                addedExternalUrls: [
                  { label: "Tetherbox job", url: "https://bridge.example/api/status#job-2" },
                  { label: "GitHub pull request", url: "https://github.com/lucasilverentand/example/pull/12" },
                ],
              },
            }),
          }),
        }),
      );
    } finally {
      restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
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

function mockFetch(calls: unknown[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      headers: init?.headers,
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}
