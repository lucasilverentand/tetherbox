import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { StateStore } from "../src/state-store";
import type { RoutedJob } from "../src/types";

describe("StateStore", () => {
  test("persists jobs and events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
    const store = new StateStore(join(dir, "state.json"));
    await store.load();

    const job: RoutedJob = {
      id: "job-1",
      sessionId: "session-1",
      prompt: "Fix it",
      issue: {
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

    await store.createJob(job);
    await store.updateJob("job-1", "running", "Started");

    const reloaded = new StateStore(join(dir, "state.json"));
    await reloaded.load();
    const snapshot = reloaded.snapshot();

    expect(snapshot.jobs[0]?.id).toBe("job-1");
    expect(snapshot.jobs[0]?.status).toBe("running");
    expect(snapshot.events.length).toBe(2);
  });
});
