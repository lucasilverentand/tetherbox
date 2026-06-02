import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createRequestHandler } from "../src/server";
import { StateStore } from "../src/state-store";
import type { BridgeConfig, DaemonState, RoutedJob } from "../src/types";

describe("server webhook handling", () => {
  test("acknowledges Linear webhooks before async job intake finishes", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const fetchMock = mockDeferredFetch();
    const state = await loadedState();
    const queue = new FakeQueue();
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = JSON.stringify({
      action: "created",
      agentSession: {
        id: "sess_1",
        promptContext: "Fix this",
        issue: {
          id: "issue-1",
          identifier: "OSS-1",
          title: "Fix this",
          description: "The checkout flow is broken.",
          teamKey: "WEB",
          labels: ["Bug"],
          url: "https://linear.app/seventwo/issue/OSS-1/fix-this",
        },
        comment: {
          body: "The latest repro is in staging.",
          user: { name: "Luca" },
        },
        guidance: [{ origin: "project", teamName: "Open Source", body: "Keep the fix minimal." }],
      },
    });

    try {
      const response = await Promise.race([
        handler(
          new Request("http://127.0.0.1:8787/webhooks/linear", {
            method: "POST",
            headers: { "Linear-Signature": signature(body, "secret") },
            body,
          }),
        ),
        sleep(50).then(() => "timeout" as const),
      ]);

      expect(response).not.toBe("timeout");
      expect(fetchMock.pending).toHaveLength(1);
      expect(queue.jobs).toHaveLength(0);
      expect(await (response as Response).json()).toMatchObject({
        ok: true,
        accepted: true,
        sessionId: "sess_1",
      });

      fetchMock.resolveNext({ data: { agentSessionUpdate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({
        data: {
          issueRepositorySuggestions: {
            suggestions: [{ repositoryFullName: "lucasilverentand/api", confidence: 0.9 }],
          },
        },
      });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentSessionUpdate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      await waitFor(() => queue.jobs.length === 1);

      expect(queue.jobs[0]?.repo.github).toBe("lucasilverentand/api");
      expect(queue.jobs[0]?.prompt).toContain("OSS-1: Fix this");
      expect(queue.jobs[0]?.prompt).toContain("The checkout flow is broken.");
      expect(queue.jobs[0]?.prompt).toContain("The latest repro is in staging.");
      expect(queue.jobs[0]?.prompt).toContain("Keep the fix minimal.");
      expect(state.snapshot().jobs[0]?.id).toBe(queue.jobs[0]?.id);
    } finally {
      fetchMock.restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("resumes a waiting approval job from an approve prompt", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const fetchMock = mockDeferredFetch();
    const state = await loadedState();
    const queue = new FakeQueue();
    await state.createJob({
      id: "job-1",
      sessionId: "sess_1",
      prompt: "Original issue context",
      issue: {
        identifier: "OSS-1",
        title: "Fix this",
        labels: [],
      },
      repo: config.repos[0]!,
      policy: {
        ruleName: "default-require-approval",
        decision: "require_approval",
        sandbox: "workspace-write",
      },
    });
    await state.updateJob("job-1", "waiting_approval", "Approval required");
    const approval = state.createApproval("job-1", "Run local Codex");
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = JSON.stringify({
      action: "prompted",
      agentSession: { id: "sess_1" },
      agentActivity: { body: "approve" },
    });

    try {
      const response = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );
      expect(response.status).toBe(200);
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      await waitFor(() => queue.jobs.length === 1);

      expect(queue.jobs[0]).toMatchObject({
        id: "job-1",
        prompt: "Original issue context",
        policy: {
          decision: "allow_auto",
          ruleName: "default-require-approval:approved",
        },
      });
      expect(state.getPendingApprovalForSession("sess_1")).toBeUndefined();
      expect(state.getJob("job-1")?.status).toBe("queued");
    } finally {
      fetchMock.restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("ignores unsupported Linear webhook actions without queueing jobs", async () => {
    const state = await loadedState();
    const queue = new FakeQueue();
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = JSON.stringify({
      action: "permissionChanged",
      agentSession: { id: "sess_ignored" },
    });

    try {
      const response = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        accepted: false,
        reason: "unsupported_action",
      });
      expect(queue.jobs).toHaveLength(0);
      expect(state.snapshot().jobs).toHaveLength(0);
      expect(state.snapshot().events[0]?.message).toContain("unsupported Linear AgentSessionEvent action");
    } finally {
      state.close();
    }
  });

  test("rejects malformed Linear webhook JSON without queueing jobs", async () => {
    const state = await loadedState();
    const queue = new FakeQueue();
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = "{not-json";

    try {
      const response = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("Invalid Linear webhook JSON"),
      });
      expect(queue.jobs).toHaveLength(0);
      expect(state.snapshot().jobs).toHaveLength(0);
    } finally {
      state.close();
    }
  });

  test("rejects Linear webhooks with invalid signatures before parsing", async () => {
    const state = await loadedState();
    const queue = new FakeQueue();
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });

    try {
      const response = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": "bad" },
          body: "{not-json",
        }),
      );

      expect(response.status).toBe(401);
      expect(queue.jobs).toHaveLength(0);
      expect(state.snapshot().jobs).toHaveLength(0);
    } finally {
      state.close();
    }
  });
});

const config: BridgeConfig = {
  server: { host: "127.0.0.1", port: 8787, publicUrl: "https://bridge.example" },
  linear: {
    webhookSecretEnv: "LINEAR_WEBHOOK_SECRET",
    apiKeyEnv: "LINEAR_API_KEY",
    repositorySuggestionMinConfidence: 0.5,
  },
  codex: { bin: "codex", sandbox: "workspace-write" },
  repos: [
    {
      linearTeams: ["WEB"],
      github: "lucasilverentand/web",
      localPath: "/tmp/web",
      defaultBase: "main",
    },
    {
      linearTeams: ["API"],
      github: "lucasilverentand/api",
      localPath: "/tmp/api",
      defaultBase: "main",
    },
  ],
  policies: [],
};

class FakeQueue {
  jobs: RoutedJob[] = [];

  enqueue(job: RoutedJob): void {
    this.jobs.push(job);
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  stats(): NonNullable<DaemonState["queue"]> {
    return {
      accepting: true,
      concurrency: 1,
      running: 0,
      queued: this.jobs.length,
    };
  }
}

async function loadedState(): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), "server-webhook-"));
  const state = new StateStore(join(dir, "daemon.sqlite"));
  await state.load();
  return state;
}

function signature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function mockDeferredFetch(): {
  pending: Array<{ resolve: (value: Response) => void }>;
  restore: () => void;
  resolveNext: (body: unknown) => void;
} {
  const original = globalThis.fetch;
  const pending: Array<{ resolve: (value: Response) => void }> = [];
  globalThis.fetch = (() => {
    return new Promise<Response>((resolve) => {
      pending.push({ resolve });
    });
  }) as typeof fetch;

  return {
    pending,
    restore: () => {
      globalThis.fetch = original;
    },
    resolveNext: (body: unknown) => {
      const next = pending.shift();
      if (!next) {
        throw new Error("No pending fetch");
      }
      next.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error("Timed out waiting for condition");
    }
    await sleep(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
