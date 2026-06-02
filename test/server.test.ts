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
    const body = linearBody({
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
      expect(queue.jobs).toHaveLength(0);
      expect(await (response as Response).json()).toMatchObject({
        ok: true,
        accepted: true,
        sessionId: "sess_1",
      });

      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentSessionUpdate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({
        data: {
          issue: {
            id: "issue-1",
            identifier: "OSS-1",
            state: { id: "state-start", name: "In Progress", type: "started" },
            team: { id: "team-1" },
            delegate: null,
          },
        },
      });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({
        data: {
          agentSession: {
            activities: {
              edges: [
                {
                  node: {
                    updatedAt: "2026-06-02T12:00:00.000Z",
                    content: {
                      __typename: "AgentActivityPromptContent",
                      body: "Earlier frozen prompt from Linear.",
                    },
                  },
                },
              ],
            },
          },
        },
      });
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
      expect(queue.jobs[0]?.prompt).toContain("Earlier frozen prompt from Linear.");
      expect(state.snapshot().jobs[0]?.id).toBe(queue.jobs[0]?.id);
      const sessionUpdates = linearSessionUpdateInputs(fetchMock.calls, "sess_1");
      expect(sessionUpdates[0]).toMatchObject({
        externalUrls: [{
          label: "Tetherbox job",
          url: expect.stringMatching(/^https:\/\/bridge\.example\/api\/status#sess_1-[a-f0-9]{8}$/),
        }],
      });
      expect(sessionUpdates[1]).toMatchObject({
        addedExternalUrls: [{
          label: "Tetherbox job",
          url: expect.stringMatching(/^https:\/\/bridge\.example\/api\/status#sess_1-[a-f0-9]{8}$/),
        }],
      });
      const activities = linearActivityInputs(fetchMock.calls);
      expect(activities).toContainEqual(
        expect.objectContaining({
          ephemeral: true,
          content: expect.objectContaining({
            type: "thought",
            body: expect.stringContaining("Received Linear session sess_1"),
          }),
        }),
      );
      expect(activities).toContainEqual(
        expect.objectContaining({
          ephemeral: true,
          content: expect.objectContaining({
            type: "thought",
            body: expect.stringContaining("Queued local Tetherbox job"),
          }),
        }),
      );
    } finally {
      fetchMock.restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("omits Linear session external URLs when no public URL is configured", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const fetchMock = mockDeferredFetch();
    const state = await loadedState();
    const queue = new FakeQueue();
    const configWithoutPublicUrl: BridgeConfig = {
      ...config,
      server: {
        host: "127.0.0.1",
        port: 8787,
      },
    };
    const handler = createRequestHandler({
      config: configWithoutPublicUrl,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
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
          labels: [],
        },
      },
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
      const sessionUpdate = linearSessionUpdateInputs(fetchMock.calls, "sess_1")[0] as Record<string, unknown> | undefined;
      expect(sessionUpdate).toBeDefined();
      expect(sessionUpdate).not.toHaveProperty("externalUrls");
      expect(sessionUpdate).not.toHaveProperty("addedExternalUrls");
      fetchMock.resolveNext({ data: { agentSessionUpdate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({
        data: {
          issue: {
            id: "issue-1",
            identifier: "OSS-1",
            state: { id: "state-start", name: "In Progress", type: "started" },
            team: { id: "team-1" },
            delegate: null,
          },
        },
      });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentSession: { activities: { edges: [] } } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({
        data: {
          issueRepositorySuggestions: {
            suggestions: [{ repositoryFullName: "lucasilverentand/web", confidence: 0.9 }],
          },
        },
      });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentSessionUpdate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      await waitFor(() => queue.jobs.length === 1);

      const sessionUpdates = linearSessionUpdateInputs(fetchMock.calls, "sess_1") as Array<Record<string, unknown>>;
      expect(sessionUpdates).toHaveLength(2);
      expect(sessionUpdates.every((input) => !("externalUrls" in input) && !("addedExternalUrls" in input))).toBe(true);
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
    const body = linearBody({
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
    const body = linearBody({
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

  test("records Linear permission-change webhooks without queueing work", async () => {
    const state = await loadedState();
    const queue = new FakeQueue();
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "PermissionChange",
      action: "teamAccessChanged",
      appUserId: "app-user-1",
      canAccessAllPublicTeams: false,
      addedTeamIds: ["team-added"],
      removedTeamIds: ["team-removed"],
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
      expect(await response.json()).toEqual({
        ok: true,
        accepted: true,
        eventType: "PermissionChange",
        action: "teamAccessChanged",
        canceledJobIds: [],
      });
      expect(queue.jobs).toHaveLength(0);
      expect(state.snapshot().jobs).toHaveLength(0);
      expect(state.snapshot().events[0]).toMatchObject({
        level: "info",
        source: "linear",
        message: expect.stringContaining("added teams: team-added"),
      });
      expect(state.snapshot().events[0]?.message).toContain("removed teams: team-removed");
    } finally {
      state.close();
    }
  });

  test("cancels active jobs when Linear removes app access to their issue team", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const queuedJob = jobFixture({
      id: "job-queued",
      sessionId: "sess_queued",
      issue: { id: "issue-1", identifier: "OSS-272", title: "Cancel on permission loss", teamId: "team-removed", labels: [] },
    });
    await state.createJob(queuedJob);
    queue.jobs.push(queuedJob);
    await state.createJob(jobFixture({
      id: "job-waiting",
      sessionId: "sess_waiting",
      issue: { id: "issue-2", identifier: "OSS-273", title: "Waiting affected job", teamId: "team-removed", labels: [] },
    }));
    await state.updateJob("job-waiting", "waiting_approval", "Approval required");
    state.createApproval("job-waiting", "Run local Codex");
    await state.createJob(jobFixture({
      id: "job-running",
      sessionId: "sess_running",
      issue: { id: "issue-3", identifier: "OSS-274", title: "Running affected job", teamId: "team-removed", labels: [] },
    }));
    await state.updateJob("job-running", "running", "Job started");
    const unaffectedJob = jobFixture({
      id: "job-unaffected",
      sessionId: "sess_unaffected",
      issue: { id: "issue-4", identifier: "OSS-275", title: "Unchanged team", teamId: "team-kept", labels: [] },
    });
    await state.createJob(unaffectedJob);
    queue.jobs.push(unaffectedJob);
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "PermissionChange",
      action: "teamAccessChanged",
      appUserId: "app-user-1",
      canAccessAllPublicTeams: false,
      removedTeamIds: ["team-removed"],
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
      const payload = await response.json() as { canceledJobIds: string[] };
      expect(new Set(payload.canceledJobIds)).toEqual(new Set(["job-queued", "job-waiting", "job-running"]));
      expect(queue.jobs.map((job) => job.id)).toEqual(["job-unaffected"]);
      expect(state.getJob("job-queued")?.status).toBe("canceled");
      expect(state.getJob("job-waiting")?.status).toBe("canceled");
      expect(state.getJob("job-running")?.status).toBe("canceled");
      expect(state.getJob("job-unaffected")?.status).toBe("queued");
      expect(state.getPendingApprovalForJob("job-waiting")).toBeUndefined();
      expect(state.snapshot().events.some((event) => event.message.includes("removed app access"))).toBe(true);
    } finally {
      state.close();
    }
  });

  test("records Linear OAuth revocation webhooks and removes stored installation", async () => {
    const state = await loadedState();
    const queue = new FakeQueue();
    state.saveLinearInstallation({
      workspaceId: "default",
      appUserId: "app-user-1",
      accessToken: "lin_access",
      refreshToken: "lin_refresh",
    });
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "OAuthApp",
      action: "revoked",
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
      expect(await response.json()).toEqual({
        ok: true,
        accepted: true,
        eventType: "OAuthApp",
        action: "revoked",
        canceledJobIds: [],
      });
      expect(queue.jobs).toHaveLength(0);
      expect(state.getLinearInstallation("default")).toBeUndefined();
      expect(state.snapshot().events[0]).toMatchObject({
        level: "warn",
        source: "linear",
        message: expect.stringContaining("OAuth app was revoked"),
      });
    } finally {
      state.close();
    }
  });

  test("records Linear app-user notification webhooks without queueing work", async () => {
    const state = await loadedState();
    const queue = new FakeQueue();
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "AppUserNotification",
      action: "issueCommentMention",
      appUserId: "app-user-1",
      notification: {
        issue: {
          id: "issue-1",
          identifier: "OSS-256",
          title: "Handle notification webhooks",
          url: "https://linear.app/seventwo/issue/OSS-256",
        },
      },
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
      expect(await response.json()).toEqual({
        ok: true,
        accepted: true,
        eventType: "AppUserNotification",
        action: "issueCommentMention",
        canceledJobIds: [],
      });
      expect(queue.jobs).toHaveLength(0);
      expect(state.snapshot().jobs).toHaveLength(0);
      expect(state.snapshot().events[0]).toMatchObject({
        level: "info",
        source: "linear",
        message: expect.stringContaining("issueCommentMention"),
      });
      expect(state.snapshot().events[0]?.message).toContain("OSS-256");
    } finally {
      state.close();
    }
  });

  test("attaches Linear mention notification context to matching active jobs", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const queuedJob = jobFixture({
      id: "job-queued",
      sessionId: "sess_queued",
      issue: { id: "issue-1", identifier: "OSS-267", title: "Attach notification context", labels: [] },
    });
    await state.createJob(queuedJob);
    queue.jobs.push(queuedJob);
    await state.createJob(jobFixture({
      id: "job-running",
      sessionId: "sess_running",
      issue: { id: "issue-1", identifier: "OSS-267", title: "Attach notification context", labels: [] },
    }));
    await state.updateJob("job-running", "running", "Job started");
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "AppUserNotification",
      action: "issueCommentMention",
      appUserId: "app-user-1",
      notification: {
        issue: {
          id: "issue-1",
          identifier: "OSS-267",
          title: "Attach notification context",
        },
        comment: {
          id: "comment-1",
          body: "Please include the latest reproduction notes.",
          url: "https://linear.app/seventwo/comment/comment-1",
          user: { name: "Luca" },
        },
      },
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
        accepted: true,
        eventType: "AppUserNotification",
        action: "issueCommentMention",
        canceledJobIds: [],
      });
      expect(queue.jobs).toHaveLength(1);
      expect(state.getJob("job-queued")?.status).toBe("queued");
      expect(state.getJob("job-running")?.status).toBe("running");
      const notificationEvents = state.snapshot().events.filter((event) => event.message.includes("issueCommentMention"));
      expect(notificationEvents).toHaveLength(3);
      expect(notificationEvents.some((event) => event.jobId === undefined)).toBe(true);
      expect(notificationEvents.some((event) => event.jobId === "job-queued")).toBe(true);
      expect(notificationEvents.some((event) => event.jobId === "job-running")).toBe(true);
      expect(notificationEvents.every((event) => event.message.includes("Please include the latest reproduction notes"))).toBe(true);
      expect(notificationEvents.every((event) => event.message.includes("Luca"))).toBe(true);
    } finally {
      state.close();
    }
  });

  test("keeps Linear mention notifications with no matching active job audit-only", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    await state.createJob(jobFixture({
      id: "job-completed",
      sessionId: "sess_completed",
      issue: { id: "issue-1", identifier: "OSS-267", title: "Attach notification context", labels: [] },
    }));
    await state.updateJob("job-completed", "completed", "Job completed");
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "AppUserNotification",
      action: "issueNewComment",
      appUserId: "app-user-1",
      notification: {
        issue: {
          id: "issue-1",
          identifier: "OSS-267",
          title: "Attach notification context",
        },
        comment: {
          id: "comment-1",
          body: "This should only be a global audit event.",
          user: { name: "Luca" },
        },
      },
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
      expect(await response.json()).toMatchObject({ canceledJobIds: [] });
      expect(queue.jobs).toHaveLength(0);
      expect(state.getJob("job-completed")?.status).toBe("completed");
      const notificationEvents = state.snapshot().events.filter((event) => event.message.includes("issueNewComment"));
      expect(notificationEvents).toHaveLength(1);
      expect(notificationEvents[0]).toMatchObject({
        jobId: undefined,
        source: "linear",
        message: expect.stringContaining("This should only be a global audit event"),
      });
    } finally {
      state.close();
    }
  });

  test("cancels matching active jobs from Linear app-user unassignment notifications", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const queuedJob = jobFixture({
      id: "job-queued",
      sessionId: "sess_queued",
      issue: { id: "issue-1", identifier: "OSS-256", title: "Handle notification webhooks", labels: [] },
    });
    await state.createJob(queuedJob);
    queue.jobs.push(queuedJob);
    await state.createJob(jobFixture({
      id: "job-waiting",
      sessionId: "sess_waiting",
      issue: { id: "issue-1", identifier: "OSS-256", title: "Handle notification webhooks", labels: [] },
    }));
    await state.updateJob("job-waiting", "waiting_approval", "Approval required");
    state.createApproval("job-waiting", "Run local Codex");
    await state.createJob(jobFixture({
      id: "job-running",
      sessionId: "sess_running",
      issue: { id: "issue-1", identifier: "OSS-256", title: "Handle notification webhooks", labels: [] },
    }));
    await state.updateJob("job-running", "running", "Job started");
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "AppUserNotification",
      action: "issueUnassignedFromYou",
      appUserId: "app-user-1",
      notification: {
        issue: {
          id: "issue-1",
          identifier: "OSS-256",
          title: "Handle notification webhooks",
        },
      },
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
      const payload = await response.json() as { canceledJobIds: string[] };
      expect(new Set(payload.canceledJobIds)).toEqual(new Set(["job-queued", "job-waiting", "job-running"]));
      expect(queue.jobs).toHaveLength(0);
      expect(state.getJob("job-queued")?.status).toBe("canceled");
      expect(state.getJob("job-waiting")?.status).toBe("canceled");
      expect(state.getJob("job-running")?.status).toBe("canceled");
      expect(state.getPendingApprovalForJob("job-waiting")).toBeUndefined();
      expect(state.snapshot().events.some((event) => event.message.includes("unassigned from the issue"))).toBe(true);
    } finally {
      state.close();
    }
  });

  test("cancels matching active jobs when a Linear issue status becomes completed", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const queuedJob = jobFixture({
      id: "job-queued",
      sessionId: "sess_queued",
      issue: { id: "issue-1", identifier: "OSS-266", title: "Cancel terminal issue jobs", labels: [] },
    });
    await state.createJob(queuedJob);
    queue.jobs.push(queuedJob);
    await state.createJob(jobFixture({
      id: "job-waiting",
      sessionId: "sess_waiting",
      issue: { id: "issue-1", identifier: "OSS-266", title: "Cancel terminal issue jobs", labels: [] },
    }));
    await state.updateJob("job-waiting", "waiting_approval", "Approval required");
    state.createApproval("job-waiting", "Run local Codex");
    await state.createJob(jobFixture({
      id: "job-running",
      sessionId: "sess_running",
      issue: { id: "issue-1", identifier: "OSS-266", title: "Cancel terminal issue jobs", labels: [] },
    }));
    await state.updateJob("job-running", "running", "Job started");
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "AppUserNotification",
      action: "issueStatusChanged",
      appUserId: "app-user-1",
      notification: {
        issue: {
          id: "issue-1",
          identifier: "OSS-266",
          title: "Cancel terminal issue jobs",
          state: { name: "Done", type: "completed" },
        },
      },
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
      const payload = await response.json() as { canceledJobIds: string[] };
      expect(new Set(payload.canceledJobIds)).toEqual(new Set(["job-queued", "job-waiting", "job-running"]));
      expect(queue.jobs).toHaveLength(0);
      expect(state.getJob("job-queued")).toMatchObject({
        status: "canceled",
        retryEligible: false,
        failureReason: "Linear issue status changed to completed",
      });
      expect(state.getJob("job-waiting")?.status).toBe("canceled");
      expect(state.getJob("job-running")?.status).toBe("canceled");
      expect(state.getPendingApprovalForJob("job-waiting")).toBeUndefined();
      expect(state.snapshot().events.some((event) => event.message.includes("moved to completed"))).toBe(true);
    } finally {
      state.close();
    }
  });

  test("cancels matching active jobs when a Linear issue status becomes canceled", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const queuedJob = jobFixture({
      id: "job-queued",
      sessionId: "sess_queued",
      issue: { id: "issue-1", identifier: "OSS-266", title: "Cancel terminal issue jobs", labels: [] },
    });
    await state.createJob(queuedJob);
    queue.jobs.push(queuedJob);
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "AppUserNotification",
      action: "issueStatusChanged",
      appUserId: "app-user-1",
      notification: {
        issue: {
          id: "issue-1",
          identifier: "OSS-266",
          title: "Cancel terminal issue jobs",
          statusType: "canceled",
          statusName: "Canceled",
        },
      },
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
      expect(await response.json()).toMatchObject({ canceledJobIds: ["job-queued"] });
      expect(queue.jobs).toHaveLength(0);
      expect(state.getJob("job-queued")).toMatchObject({
        status: "canceled",
        retryEligible: false,
        failureReason: "Linear issue status changed to canceled",
      });
      expect(state.snapshot().events.some((event) => event.message.includes("moved to canceled"))).toBe(true);
    } finally {
      state.close();
    }
  });

  test("keeps non-terminal Linear issue status changes audit-only", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const queuedJob = jobFixture({
      id: "job-queued",
      sessionId: "sess_queued",
      issue: { id: "issue-1", identifier: "OSS-266", title: "Cancel terminal issue jobs", labels: [] },
    });
    await state.createJob(queuedJob);
    queue.jobs.push(queuedJob);
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "AppUserNotification",
      action: "issueStatusChanged",
      appUserId: "app-user-1",
      notification: {
        issue: {
          id: "issue-1",
          identifier: "OSS-266",
          title: "Cancel terminal issue jobs",
          state: { name: "In Progress", type: "started" },
        },
      },
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
      expect(await response.json()).toMatchObject({ canceledJobIds: [] });
      expect(queue.jobs).toHaveLength(1);
      expect(state.getJob("job-queued")?.status).toBe("queued");
      expect(state.snapshot().events.some((event) => event.message.includes("status: In Progress"))).toBe(true);
      expect(state.snapshot().events.some((event) => event.message.includes("moved to started"))).toBe(false);
    } finally {
      state.close();
    }
  });

  test("keeps Linear issue status changes without status metadata audit-only", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const queuedJob = jobFixture({
      id: "job-queued",
      sessionId: "sess_queued",
      issue: { id: "issue-1", identifier: "OSS-266", title: "Cancel terminal issue jobs", labels: [] },
    });
    await state.createJob(queuedJob);
    queue.jobs.push(queuedJob);
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "AppUserNotification",
      action: "issueStatusChanged",
      appUserId: "app-user-1",
      notification: {
        issue: {
          id: "issue-1",
          identifier: "OSS-266",
          title: "Cancel terminal issue jobs",
        },
      },
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
      expect(await response.json()).toMatchObject({ canceledJobIds: [] });
      expect(queue.jobs).toHaveLength(1);
      expect(state.getJob("job-queued")?.status).toBe("queued");
      expect(state.snapshot().events.some((event) => event.message.includes("issueStatusChanged"))).toBe(true);
      expect(state.snapshot().events.some((event) => event.message.includes("moved to"))).toBe(false);
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

  test("rejects stale Linear webhook timestamps before queueing jobs", async () => {
    const state = await loadedState();
    const queue = new FakeQueue();
    const handler = createRequestHandler({
      config: { ...config, linear: { ...config.linear, webhookMaxAgeMs: 1_000 } },
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      action: "created",
      agentSession: { id: "sess_stale" },
    }, Date.now() - 2_000);

    try {
      const response = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: "stale_webhook" });
      expect(queue.jobs).toHaveLength(0);
      expect(state.snapshot().jobs).toHaveLength(0);
      expect(state.snapshot().events).toContainEqual(expect.objectContaining({
        level: "warn",
        source: "linear",
        message: "Linear webhook timestamp is outside the accepted freshness window",
      }));
    } finally {
      state.close();
    }
  });

  test("rejects missing Linear webhook timestamps before queueing jobs", async () => {
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
      agentSession: { id: "sess_missing_timestamp" },
    });

    try {
      const response = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: "missing_webhook_timestamp" });
      expect(queue.jobs).toHaveLength(0);
      expect(state.snapshot().jobs).toHaveLength(0);
    } finally {
      state.close();
    }
  });

  test("rejects malformed Linear webhook timestamps before queueing jobs", async () => {
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
      webhookTimestamp: "now",
      agentSession: { id: "sess_bad_timestamp" },
    });

    try {
      const response = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: "invalid_webhook_timestamp" });
      expect(queue.jobs).toHaveLength(0);
      expect(state.snapshot().jobs).toHaveLength(0);
    } finally {
      state.close();
    }
  });

  test("deduplicates retried Linear Agent Session webhooks by delivery header", async () => {
    const state = await loadedState();
    const queue = new FakeQueue();
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      action: "created",
      agentSession: {
        id: "sess_duplicate",
        promptContext: "Fix this",
        issue: {
          id: "issue-duplicate",
          identifier: "OSS-260",
          title: "Deduplicate webhooks",
          teamKey: "WEB",
          labels: [],
        },
      },
    });

    try {
      const first = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: {
            "Linear-Signature": signature(body, "secret"),
            "Linear-Delivery": "delivery-agent-1",
          },
          body,
        }),
      );
      await waitFor(() => queue.jobs.length === 1);

      const second = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: {
            "Linear-Signature": signature(body, "secret"),
            "Linear-Delivery": "delivery-agent-1",
          },
          body,
        }),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({
        accepted: false,
        reason: "duplicate_webhook",
        deliveryId: "delivery-agent-1",
      });
      expect(queue.jobs).toHaveLength(1);
      expect(state.snapshot().jobs).toHaveLength(1);
      expect(state.snapshot().events).toContainEqual(expect.objectContaining({
        level: "info",
        source: "linear",
        message: "Ignored duplicate Linear webhook delivery delivery-agent-1",
      }));
    } finally {
      state.close();
    }
  });

  test("deduplicates retried Linear management webhooks by payload webhookId", async () => {
    const state = await loadedState();
    const queue = new FakeQueue();
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "PermissionChange",
      action: "teamAccessChanged",
      webhookId: "delivery-management-1",
      appUserId: "app-user-1",
      canAccessAllPublicTeams: false,
      addedTeamIds: ["team-1"],
      removedTeamIds: [],
    });

    try {
      const first = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );
      const second = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );
      const events = state.snapshot().events;

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ accepted: false, reason: "duplicate_webhook" });
      expect(events.filter((event) => event.message.includes("Linear app team access changed"))).toHaveLength(1);
      expect(events.filter((event) => event.message.includes("Ignored duplicate Linear webhook delivery"))).toHaveLength(1);
      expect(queue.jobs).toHaveLength(0);
    } finally {
      state.close();
    }
  });

  test("deduplicates retried Linear inbox notification webhooks before repeating side effects", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    await state.createJob(jobFixture({
      id: "job-running",
      sessionId: "sess_running",
      issue: { id: "issue-1", identifier: "OSS-260", title: "Deduplicate webhooks", labels: [] },
    }));
    queue.jobs.push(jobFixture({
      id: "job-running",
      sessionId: "sess_running",
      issue: { id: "issue-1", identifier: "OSS-260", title: "Deduplicate webhooks", labels: [] },
    }));
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      type: "AppUserNotification",
      action: "issueUnassignedFromYou",
      webhookId: "delivery-inbox-1",
      appUserId: "app-user-1",
      notification: {
        issue: {
          id: "issue-1",
          identifier: "OSS-260",
          title: "Deduplicate webhooks",
        },
      },
    });

    try {
      const first = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );
      const second = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );
      const secondPayload = await second.json() as { accepted: boolean; reason: string };
      const events = state.snapshot().events;

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(secondPayload).toMatchObject({ accepted: false, reason: "duplicate_webhook" });
      expect(queue.jobs).toHaveLength(0);
      expect(state.getJob("job-running")?.status).toBe("canceled");
      expect(events.filter((event) => event.message.includes("issueUnassignedFromYou"))).toHaveLength(1);
      expect(events.filter((event) => event.message.includes("Ignored duplicate Linear webhook delivery"))).toHaveLength(1);
    } finally {
      state.close();
    }
  });

  test("cancels a queued job from a Linear stop signal", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const fetchMock = mockDeferredFetch();
    const state = await loadedState();
    const queue = new FakeQueue(state);
    await state.createJob(jobFixture({ id: "tetherbox-sess_stop", sessionId: "sess_stop" }));
    queue.jobs.push(jobFixture({ id: "tetherbox-sess_stop", sessionId: "sess_stop" }));
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      action: "prompted",
      agentSession: { id: "sess_stop" },
      agentActivity: { body: "stop", signal: "stop" },
    });

    try {
      const response = await handler(
        new Request("http://127.0.0.1:8787/webhooks/linear", {
          method: "POST",
          headers: { "Linear-Signature": signature(body, "secret") },
          body,
        }),
      );

      expect(await response.json()).toMatchObject({ ok: true, stop: true });
      await waitFor(() => state.getJob("tetherbox-sess_stop")?.status === "canceled");
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      expect(queue.jobs).toHaveLength(0);
    } finally {
      fetchMock.restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("cancels a waiting approval job from a Linear stop signal", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const fetchMock = mockDeferredFetch();
    const state = await loadedState();
    const queue = new FakeQueue(state);
    await state.createJob(jobFixture({ id: "tetherbox-sess_wait", sessionId: "sess_wait" }));
    await state.updateJob("tetherbox-sess_wait", "waiting_approval", "Approval required");
    state.createApproval("tetherbox-sess_wait", "Run local Codex");
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      action: "prompted",
      agentSession: { id: "sess_wait" },
      agentActivity: { body: "Please stop", signal: "stop" },
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
      await waitFor(() => state.getJob("tetherbox-sess_wait")?.status === "canceled");
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      expect(state.getPendingApprovalForSession("sess_wait")).toBeUndefined();
    } finally {
      fetchMock.restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("records stop signals with no active job without creating work", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const fetchMock = mockDeferredFetch();
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      action: "prompted",
      agentSession: { id: "sess_idle" },
      agentActivity: { body: "stop", signal: "stop" },
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
      await waitFor(() => state.snapshot().events.length === 1);
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      expect(state.snapshot().jobs).toHaveLength(0);
      expect(queue.jobs).toHaveLength(0);
      expect(state.snapshot().events[0]?.message).toContain("no active job");
    } finally {
      fetchMock.restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("asks Linear to select a repo when routing is ambiguous", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const fetchMock = mockDeferredFetch();
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      action: "created",
      agentSession: {
        id: "sess_select",
        promptContext: "Fix this without a repo hint",
        issue: {
          identifier: "OSS-230",
          title: "Pick a repo",
          labels: [],
        },
      },
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
      fetchMock.resolveNext({ data: { agentSessionUpdate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({
        data: {
          issue: {
            id: "issue-230",
            identifier: "OSS-230",
            state: { id: "state-start", name: "In Progress", type: "started" },
            team: { id: "team-1" },
            delegate: null,
          },
        },
      });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({
        data: {
          agentSession: {
            activities: {
              edges: [],
            },
          },
        },
      });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentSessionUpdate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      await waitFor(() => state.getPendingRepoSelectionForSession("sess_select") !== undefined);

      expect(queue.jobs).toHaveLength(0);
      expect(state.snapshot().jobs).toHaveLength(0);
      expect(state.getPendingRepoSelectionForSession("sess_select")).toMatchObject({
        sessionId: "sess_select",
        issue: {
          identifier: "OSS-230",
        },
      });
    } finally {
      fetchMock.restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("queues the original job after a Linear repo selection reply", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const fetchMock = mockDeferredFetch();
    const state = await loadedState();
    const queue = new FakeQueue(state);
    state.createRepoSelection(jobFixture({
      id: "job-select",
      sessionId: "sess_select",
      prompt: "Original issue context",
    }));
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      action: "prompted",
      agentSession: { id: "sess_select", promptContext: "Original issue context" },
      agentActivity: {
        body: "lucasilverentand/api",
        signal: "select",
        signalMetadata: { value: "lucasilverentand/api" },
      },
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
      fetchMock.resolveNext({ data: { agentSessionUpdate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      await waitFor(() => queue.jobs.length === 1);

      expect(queue.jobs[0]).toMatchObject({
        id: "job-select",
        sessionId: "sess_select",
        prompt: "Original issue context",
        repo: {
          github: "lucasilverentand/api",
        },
      });
      expect(state.getPendingRepoSelectionForSession("sess_select")).toBeUndefined();
      expect(state.getJob("job-select")?.repo).toBe("lucasilverentand/api");
    } finally {
      fetchMock.restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("queues the original job after a free-text full repo selection reply", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const fetchMock = mockDeferredFetch();
    const state = await loadedState();
    const queue = new FakeQueue(state);
    state.createRepoSelection(jobFixture({
      id: "job-select",
      sessionId: "sess_select",
      prompt: "Original issue context",
    }));
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      action: "prompted",
      agentSession: { id: "sess_select", promptContext: "Original issue context" },
      agentActivity: {
        body: "Use https://github.com/lucasilverentand/api for this one.",
      },
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
      fetchMock.resolveNext({ data: { agentSessionUpdate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      await waitFor(() => queue.jobs.length === 1);

      expect(queue.jobs[0]?.repo.github).toBe("lucasilverentand/api");
      expect(state.getPendingRepoSelectionForSession("sess_select")).toBeUndefined();
    } finally {
      fetchMock.restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("queues the original job after a clear free-text repo name reply", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const fetchMock = mockDeferredFetch();
    const state = await loadedState();
    const queue = new FakeQueue(state);
    state.createRepoSelection(jobFixture({
      id: "job-select",
      sessionId: "sess_select",
      prompt: "Original issue context",
    }));
    const handler = createRequestHandler({
      config,
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      action: "prompted",
      agentSession: { id: "sess_select", promptContext: "Original issue context" },
      agentActivity: {
        body: "Use the api repo.",
      },
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
      fetchMock.resolveNext({ data: { agentSessionUpdate: { success: true } } });
      await waitFor(() => fetchMock.pending.length === 1);
      fetchMock.resolveNext({ data: { agentActivityCreate: { success: true } } });
      await waitFor(() => queue.jobs.length === 1);

      expect(queue.jobs[0]?.repo.github).toBe("lucasilverentand/api");
      expect(state.getPendingRepoSelectionForSession("sess_select")).toBeUndefined();
    } finally {
      fetchMock.restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("re-posts repo selection when free-text repo selection is ambiguous", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    const fetchMock = mockDeferredFetch();
    const state = await loadedState();
    const queue = new FakeQueue(state);
    state.createRepoSelection(jobFixture({
      id: "job-select",
      sessionId: "sess_select",
      prompt: "Original issue context",
    }));
    const handler = createRequestHandler({
      config: {
        ...config,
        repos: [
          { ...config.repos[0]!, github: "lucasilverentand/api" },
          { ...config.repos[1]!, github: "seventwo/api" },
        ],
      },
      state,
      queue,
      webhookSecret: "secret",
    });
    const body = linearBody({
      action: "prompted",
      agentSession: { id: "sess_select", promptContext: "Original issue context" },
      agentActivity: {
        body: "Use the api repo.",
      },
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
      await waitFor(() => fetchMock.pending.length === 0);

      expect(queue.jobs).toHaveLength(0);
      expect(state.getPendingRepoSelectionForSession("sess_select")).toBeDefined();
      const selectionActivity = linearActivityInputs(fetchMock.calls)[0];
      expect(selectionActivity).toEqual(
        expect.objectContaining({
          signal: "select",
          signalMetadata: expect.objectContaining({
            options: [
              { label: "lucasilverentand/api", value: "lucasilverentand/api" },
              { label: "seventwo/api", value: "seventwo/api" },
            ],
          }),
        }),
      );
    } finally {
      fetchMock.restore();
      state.close();
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("retries eligible jobs from the local operator API", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const handler = createRequestHandler({ config, state, queue, webhookSecret: "secret" });
    await state.createJob(jobFixture());
    await state.updateJob("job-1", "failed", "Codex failed", {
      retryEligible: true,
      incrementRetryCount: true,
      failureReason: "Codex failed",
    });

    try {
      const response = await handler(new Request("http://127.0.0.1/api/jobs/job-1/retry", { method: "POST" }));
      const body = await response.json();

      expect(body).toEqual({ ok: true });
      expect(queue.jobs).toHaveLength(1);
      expect(queue.jobs[0]?.id).toBe("job-1");
      expect(state.getJob("job-1")).toMatchObject({
        status: "queued",
        retryEligible: false,
        lastMessage: "Retry queued from TUI",
      });
    } finally {
      state.close();
    }
  });

  test("approves and denies waiting jobs from the local operator API", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const handler = createRequestHandler({ config, state, queue, webhookSecret: "secret" });
    await state.createJob(jobFixture({ id: "job-approve", policy: { ruleName: "approval", decision: "require_approval", sandbox: "workspace-write" } }));
    await state.updateJob("job-approve", "waiting_approval", "Approval required");
    state.createApproval("job-approve", "Run local Codex");
    await state.createJob(jobFixture({ id: "job-deny", sessionId: "sess_2", policy: { ruleName: "approval", decision: "require_approval", sandbox: "workspace-write" } }));
    await state.updateJob("job-deny", "waiting_approval", "Approval required");
    state.createApproval("job-deny", "Run local Codex");

    try {
      const approve = await handler(
        new Request("http://127.0.0.1/api/jobs/job-approve/approve", { method: "POST" }),
      );
      const deny = await handler(new Request("http://127.0.0.1/api/jobs/job-deny/deny", { method: "POST" }));

      expect(await approve.json()).toEqual({ ok: true });
      expect(await deny.json()).toEqual({ ok: true });
      expect(queue.jobs.find((job) => job.id === "job-approve")).toMatchObject({
        policy: { decision: "allow_auto" },
      });
      expect(state.getJob("job-approve")?.status).toBe("queued");
      expect(state.getJob("job-deny")?.status).toBe("canceled");
    } finally {
      state.close();
    }
  });

  test("requires an operator token for non-loopback job actions", async () => {
    const state = await loadedState();
    const queue = new FakeQueue(state);
    const handler = createRequestHandler({
      config: { ...config, server: { ...config.server, operatorTokenEnv: "TETHERBOX_OPERATOR_TOKEN" } },
      state,
      queue,
      webhookSecret: "secret",
    });
    await state.createJob(jobFixture());
    await state.updateJob("job-1", "failed", "Codex failed", { retryEligible: true });
    process.env.TETHERBOX_OPERATOR_TOKEN = "operator-secret";

    try {
      const rejected = await handler(new Request("https://bridge.example/api/jobs/job-1/retry", { method: "POST" }));
      const accepted = await handler(
        new Request("https://bridge.example/api/jobs/job-1/retry", {
          method: "POST",
          headers: { Authorization: "Bearer operator-secret" },
        }),
      );

      expect(rejected.status).toBe(401);
      expect(await accepted.json()).toEqual({ ok: true });
    } finally {
      delete process.env.TETHERBOX_OPERATOR_TOKEN;
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

  constructor(private readonly state?: StateStore) {}

  enqueue(job: RoutedJob): void {
    this.jobs.push(job);
  }

  async cancel(jobId: string): Promise<boolean> {
    const index = this.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) {
      return false;
    }
    this.jobs.splice(index, 1);
    await this.state?.updateJob(jobId, "canceled", "Canceled before running");
    return true;
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

function jobFixture(overrides: Partial<RoutedJob> = {}): RoutedJob {
  return {
    id: "job-1",
    sessionId: "sess_1",
    prompt: "Fix it",
    issue: {
      identifier: "OSS-1",
      title: "Fix this",
      labels: [],
    },
    repo: config.repos[0]!,
    policy: {
      ruleName: "default-auto",
      decision: "allow_auto",
      sandbox: "workspace-write",
    },
    ...overrides,
  };
}

function signature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function linearBody(payload: Record<string, unknown>, webhookTimestamp = Date.now()): string {
  return JSON.stringify({ webhookTimestamp, ...payload });
}

function mockDeferredFetch(): {
  calls: unknown[];
  pending: Array<{ resolve: (value: Response) => void }>;
  restore: () => void;
  resolveNext: (body: unknown) => void;
} {
  const original = globalThis.fetch;
  const calls: unknown[] = [];
  const pending: Array<{ resolve: (value: Response) => void }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body !== undefined) {
      try {
        calls.push({
          headers: init.headers,
          body: JSON.parse(String(init.body)),
        });
      } catch {
        calls.push(init.body);
      }
    } else {
      calls.push(input);
    }
    return new Promise<Response>((resolve) => {
      pending.push({ resolve });
    });
  }) as typeof fetch;

  return {
    calls,
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

function linearSessionUpdateInputs(calls: unknown[], sessionId: string): unknown[] {
  return calls
    .map((call) => {
      if (
        typeof call === "object"
        && call !== null
        && "body" in call
        && typeof call.body === "object"
        && call.body !== null
        && "query" in call.body
        && typeof call.body.query === "string"
        && call.body.query.includes("agentSessionUpdate")
        && "variables" in call.body
        && typeof call.body.variables === "object"
        && call.body.variables !== null
        && "id" in call.body.variables
        && call.body.variables.id === sessionId
        && "input" in call.body.variables
      ) {
        return call.body.variables.input;
      }
      return undefined;
    })
    .filter((input) => input !== undefined);
}

function linearActivityInputs(calls: unknown[]): unknown[] {
  return calls
    .map((call) => {
      if (
        typeof call === "object"
        && call !== null
        && "body" in call
        && typeof call.body === "object"
        && call.body !== null
        && "query" in call.body
        && typeof call.body.query === "string"
        && call.body.query.includes("agentActivityCreate")
        && "variables" in call.body
        && typeof call.body.variables === "object"
        && call.body.variables !== null
        && "input" in call.body.variables
      ) {
        return call.body.variables.input;
      }
      return undefined;
    })
    .filter((input) => input !== undefined);
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
