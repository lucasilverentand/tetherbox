import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { branchNameForIssue, branchNameForJob, daemonStateDirectory, worktreePathForJob, worktreeRoot } from "../src/worktree-manager";
import type { BridgeConfig, RoutedJob } from "../src/types";

const config: BridgeConfig = {
  server: { host: "127.0.0.1", port: 8787 },
  state: { path: "state/daemon.sqlite" },
  linear: { webhookSecretEnv: "LINEAR_WEBHOOK_SECRET" },
  codex: { bin: "codex", sandbox: "workspace-write" },
  repos: [
    {
      linearTeams: ["ENG"],
      github: "lucasilverentand/example",
      localPath: "/tmp/example",
      defaultBase: "main",
    },
  ],
  policies: [],
};

describe("worktree manager", () => {
  test("builds branch names from Linear key and title slug", () => {
    expect(
      branchNameForIssue({
        identifier: "OSS-231",
        title: "Build Git worktree manager",
        labels: [],
      }),
    ).toBe("oss-231-build-git-worktree-manager");
  });

  test("sanitizes branch names without reserved agent prefixes", () => {
    const branchName = branchNameForIssue({
      identifier: "ENG-7",
      title: "Codex/Claude branch cleanup!",
      labels: [],
    });

    expect(branchName).toBe("eng-7-codex-claude-branch-cleanup");
    expect(branchName.startsWith("codex/")).toBe(false);
    expect(branchName.startsWith("claude/")).toBe(false);
  });

  test("adds a short job suffix to work branch names", () => {
    const job: RoutedJob = {
      id: "9d1ba725-2086-497e-b0f4-d2da433d3c1d-f5df3ad3",
      sessionId: "session-1",
      prompt: "Fix it",
      issue: { identifier: "OSS-292", title: "Run a fake website through Tetherbox validation", labels: [] },
      repo: config.repos[0]!,
      policy: { ruleName: "docs-auto", decision: "allow_auto", sandbox: "workspace-write" },
    };

    expect(branchNameForJob(job)).toBe("oss-292-run-a-fake-website-through-tetherbox-validation-f5df3ad3");
  });

  test("places job worktrees under the daemon state directory", () => {
    const job: RoutedJob = {
      id: "session/1 with spaces",
      sessionId: "session-1",
      prompt: "Fix it",
      issue: { identifier: "OSS-231", title: "Build Git worktree manager", labels: [] },
      repo: config.repos[0]!,
      policy: { ruleName: "docs-auto", decision: "allow_auto", sandbox: "workspace-write" },
    };

    expect(daemonStateDirectory(config)).toBe(resolve("state"));
    expect(worktreeRoot(config)).toBe(resolve("state", "worktrees"));
    expect(worktreePathForJob(config, job)).toBe(join(resolve("state", "worktrees"), "session-1-with-spaces"));
  });
});
