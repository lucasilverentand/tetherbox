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
