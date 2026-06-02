import { describe, expect, test } from "bun:test";
import { finalizeSuccessfulRun, type CommandResult, type CommandRunner } from "../src/pr-automation";
import type { BridgeConfig, RoutedJob } from "../src/types";

describe("pull request automation", () => {
  test("runs validation and skips PR creation when there are no changes", async () => {
    const runner = new FakeRunner([{ stdout: "", stderr: "" }]);

    const result = await finalizeSuccessfulRun(config, job, worktree, runner);

    expect(result.status).toBe("no_changes");
    expect(runner.commands).toEqual([
      { kind: "shell", command: "bun test", cwd: "/tmp/worktree" },
      { kind: "run", command: "git", args: ["status", "--porcelain"], cwd: "/tmp/worktree" },
    ]);
  });

  test("stops when validation fails", async () => {
    const runner = new FakeRunner([]);
    runner.failShell = true;

    await expect(finalizeSuccessfulRun(config, job, worktree, runner)).rejects.toThrow("validation failed");
    expect(runner.commands).toEqual([{ kind: "shell", command: "bun test", cwd: "/tmp/worktree" }]);
  });

  test("commits, pushes, and opens a PR when changes exist", async () => {
    const runner = new FakeRunner([
      { stdout: " M src/app.ts\n", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "https://github.com/lucasilverentand/example/pull/42\n", stderr: "" },
    ]);

    const result = await finalizeSuccessfulRun(config, job, worktree, runner);

    expect(result).toEqual({
      status: "created",
      url: "https://github.com/lucasilverentand/example/pull/42",
      number: 42,
    });
    expect(runner.commands.map((command) => command.command)).toEqual([
      "bun test",
      "git",
      "git",
      "git",
      "git",
      "gh",
    ]);
    const commit = runner.commands.find(
      (command) => command.kind === "run" && command.command === "git" && command.args[0] === "commit",
    );
    expect(commit).toMatchObject({
      args: expect.arrayContaining(["commit", "-S", "-m", "Co-authored-by: Codex <codex@openai.com>"]),
    });
  });
});

const config: BridgeConfig = {
  server: { host: "127.0.0.1", port: 8787, publicUrl: "https://bridge.example" },
  linear: { webhookSecretEnv: "LINEAR_WEBHOOK_SECRET" },
  codex: { bin: "codex", sandbox: "workspace-write" },
  repos: [],
  policies: [],
};

const job: RoutedJob = {
  id: "job-1",
  sessionId: "sess-1",
  prompt: "Fix it",
  issue: {
    identifier: "OSS-1",
    title: "Fix checkout",
    url: "https://linear.app/seventwo/issue/OSS-1/fix-checkout",
    labels: [],
  },
  repo: {
    linearTeams: ["OSS"],
    github: "lucasilverentand/example",
    localPath: "/tmp/example",
    defaultBase: "main",
    testCommands: ["bun test"],
  },
  policy: {
    ruleName: "docs-auto",
    decision: "allow_auto",
    sandbox: "workspace-write",
  },
};

const worktree = {
  branchName: "oss-1-fix-checkout",
  path: "/tmp/worktree",
};

class FakeRunner implements CommandRunner {
  commands: Array<
    | { kind: "run"; command: string; args: string[]; cwd: string }
    | { kind: "shell"; command: string; cwd: string }
  > = [];
  failShell = false;

  constructor(private readonly results: CommandResult[]) {}

  async run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    this.commands.push({ kind: "run", command, args, cwd });
    return this.next();
  }

  async runShell(command: string, cwd: string): Promise<CommandResult> {
    this.commands.push({ kind: "shell", command, cwd });
    if (this.failShell) {
      throw new Error("validation failed");
    }
    return { stdout: "", stderr: "" };
  }

  private next(): CommandResult {
    const result = this.results.shift();
    if (!result) {
      throw new Error("Unexpected command");
    }
    return result;
  }
}
