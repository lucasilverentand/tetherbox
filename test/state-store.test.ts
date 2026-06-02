import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { StateStore } from "../src/state-store";
import type { RepoMapping, RoutedJob } from "../src/types";

describe("StateStore", () => {
  test("creates durable SQLite tables", async () => {
    const path = await statePath();
    const store = new StateStore(path);
    await store.load();
    store.close();

    const db = new Database(path);
    const tables = db
      .query("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    db.close();

    expect(tables).toContain("sessions");
    expect(tables).toContain("jobs");
    expect(tables).toContain("job_events");
    expect(tables).toContain("approvals");
    expect(tables).toContain("pull_requests");
    expect(tables).toContain("repo_mappings");
  });

  test("persists jobs and events across restarts", async () => {
    const path = await statePath();
    const store = new StateStore(path);
    await store.load();

    await store.createJob(jobFixture());
    await store.updateJob("job-1", "running", "Started");
    store.close();

    const reloaded = new StateStore(path);
    await reloaded.load();
    const snapshot = reloaded.snapshot();
    reloaded.close();

    expect(snapshot.jobs[0]?.id).toBe("job-1");
    expect(snapshot.jobs[0]?.status).toBe("running");
    expect(snapshot.jobs[0]?.lastMessage).toBe("Started");
    expect(snapshot.events.length).toBe(2);
    expect(snapshot.events.map((event) => event.message)).toContain("Started");
  });

  test("persists job worktree details", async () => {
    const path = await statePath();
    const store = new StateStore(path);
    await store.load();

    await store.createJob(jobFixture());
    await store.setJobWorktree("job-1", {
      branchName: "eng-1-fix-it",
      path: join(tmpdir(), "worktrees", "job-1"),
    });

    const snapshot = store.snapshot();
    store.close();

    expect(snapshot.jobs[0]?.branchName).toBe("eng-1-fix-it");
    expect(snapshot.jobs[0]?.worktreePath).toEndWith(join("worktrees", "job-1"));
  });

  test("persists Codex thread IDs for Linear sessions", async () => {
    const path = await statePath();
    const store = new StateStore(path);
    await store.load();

    await store.createJob(jobFixture());
    expect(store.getSessionThreadId("session-1")).toBeUndefined();
    await store.setSessionThreadId("session-1", "thread-1", "job-1");
    store.close();

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.getSessionThreadId("session-1")).toBe("thread-1");
    reloaded.close();
  });

  test("consumes Linear OAuth state once and rejects expired state", async () => {
    const path = await statePath();
    const store = new StateStore(path);
    await store.load();
    const now = new Date("2026-06-02T12:00:00.000Z");

    store.createLinearOAuthState("state-1", "https://bridge.example/oauth/linear/callback", "2026-06-02T12:05:00.000Z");
    store.createLinearOAuthState("state-2", "https://bridge.example/oauth/linear/callback", "2026-06-02T11:59:00.000Z");

    expect(store.consumeLinearOAuthState("state-1", now)?.redirectUri).toBe(
      "https://bridge.example/oauth/linear/callback",
    );
    expect(store.consumeLinearOAuthState("state-1", now)).toBeUndefined();
    expect(store.consumeLinearOAuthState("state-2", now)).toBeUndefined();
    store.close();
  });

  test("persists Linear OAuth installations", async () => {
    const path = await statePath();
    const store = new StateStore(path);
    await store.load();

    store.saveLinearInstallation({
      workspaceId: "default",
      appUserId: "app-user-1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      scope: "read write app:assignable app:mentionable",
      expiresAt: "2026-06-03T12:00:00.000Z",
    });
    store.close();

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.getLinearInstallation("default")).toMatchObject({
      workspaceId: "default",
      appUserId: "app-user-1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    reloaded.close();
  });

  test("persists pull request metadata", async () => {
    const path = await statePath();
    const store = new StateStore(path);
    await store.load();
    await store.createJob(jobFixture());

    store.savePullRequest({
      jobId: "job-1",
      githubRepo: "lucasilverentand/example",
      branchName: "oss-1-fix-it",
      prNumber: 42,
      url: "https://github.com/lucasilverentand/example/pull/42",
      status: "open",
    });
    store.close();

    const db = new Database(path);
    const row = db.query("select * from pull_requests where job_id = ?").get("job-1") as {
      github_repo: string;
      branch_name: string;
      pr_number: number;
      url: string;
    } | null;
    db.close();

    expect(row).toMatchObject({
      github_repo: "lucasilverentand/example",
      branch_name: "oss-1-fix-it",
      pr_number: 42,
      url: "https://github.com/lucasilverentand/example/pull/42",
    });
  });

  test("syncs repo mappings durably", async () => {
    const path = await statePath();
    const repo: RepoMapping = {
      linearTeams: ["ENG"],
      github: "lucasilverentand/example",
      localPath: "/tmp/example",
      defaultBase: "main",
      testCommands: ["bun test"],
    };
    const store = new StateStore(path);
    await store.load();
    store.syncRepoMappings([repo]);
    store.close();

    const db = new Database(path);
    const row = db.query("select * from repo_mappings where github = ?").get(repo.github) as {
      local_path: string;
      linear_teams_json: string;
      test_commands_json: string;
    } | null;
    db.close();

    expect(row?.local_path).toBe("/tmp/example");
    expect(JSON.parse(row?.linear_teams_json ?? "[]")).toEqual(["ENG"]);
    expect(JSON.parse(row?.test_commands_json ?? "[]")).toEqual(["bun test"]);
  });

  test("keeps status snapshots compatible with the TUI", async () => {
    const path = await statePath();
    const store = new StateStore(path);
    await store.load();
    await store.createJob(jobFixture());

    const snapshot = store.snapshot();
    store.close();

    expect(typeof snapshot.startedAt).toBe("string");
    expect(Array.isArray(snapshot.jobs)).toBe(true);
    expect(Array.isArray(snapshot.events)).toBe(true);
    expect(snapshot.jobs[0]).toMatchObject({
      id: "job-1",
      sessionId: "session-1",
      repo: "lucasilverentand/example",
      status: "queued",
    });
  });
});

async function statePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  return join(dir, "daemon.sqlite");
}

function jobFixture(): RoutedJob {
  return {
    id: "job-1",
    sessionId: "session-1",
    prompt: "Fix it",
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Fix it",
      labels: ["docs"],
    },
    repo: {
      linearTeams: ["ENG"],
      github: "lucasilverentand/example",
      localPath: "/tmp/example",
      defaultBase: "main",
    },
    policy: {
      ruleName: "docs-auto",
      decision: "allow_auto",
      sandbox: "workspace-write",
    },
  };
}
