import { describe, expect, test } from "bun:test";
import {
  finalizeSuccessfulRun,
  GitHubAuthenticationRequiredError,
  isGitHubAuthenticationFailure,
  parsePullRequestCheckOutput,
  ValidationFailedError,
  watchPullRequestChecks,
  type CommandResult,
  type CommandRunner,
} from "../src/pr-automation";
import type { BridgeConfig, RoutedJob } from "../src/types";

describe("pull request automation", () => {
  test("runs validation and skips PR creation when there are no changes", async () => {
    const runner = new FakeRunner([{ stdout: "", stderr: "" }]);
    runner.shellResults.push({ stdout: "ok\n", stderr: "" });

    const result = await finalizeSuccessfulRun(config, job, worktree, runner);

    expect(result.status).toBe("no_changes");
    expect(result.validation).toEqual([
      {
        command: "bun test",
        status: "passed",
        stdout: "ok\n",
        stderr: "",
        summary: "ok",
      },
    ]);
    expect(runner.commands).toEqual([
      { kind: "shell", command: "bun test", cwd: "/tmp/worktree" },
      { kind: "run", command: "git", args: ["status", "--porcelain"], cwd: "/tmp/worktree" },
    ]);
  });

  test("stops when validation fails", async () => {
    const runner = new FakeRunner([]);
    runner.failShell = true;

    try {
      await finalizeSuccessfulRun(config, job, worktree, runner);
      throw new Error("Expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationFailedError);
      if (!(error instanceof ValidationFailedError)) {
        throw error;
      }
      expect(error.results).toEqual([
        {
          command: "bun test",
          status: "failed",
          stdout: "",
          stderr: "validation failed",
          summary: "validation failed",
        },
      ]);
    }
    expect(runner.commands).toEqual([{ kind: "shell", command: "bun test", cwd: "/tmp/worktree" }]);
  });

  test("commits, pushes, and opens a PR when changes exist", async () => {
    const runner = new FakeRunner([
      { stdout: " M src/app.ts\n", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "https://github.com/lucasilverentand/example/pull/42\n", stderr: "" },
    ]);
    runner.shellResults.push({ stdout: "tests passed\n", stderr: "" });
    runner.existingFiles.add("/tmp/codex_signing_key");

    const result = await finalizeSuccessfulRun(signedConfig, job, worktree, runner);

    expect(result).toEqual({
      status: "created",
      url: "https://github.com/lucasilverentand/example/pull/42",
      number: 42,
      warnings: [],
      validation: [
        {
          command: "bun test",
          status: "passed",
          stdout: "tests passed\n",
          stderr: "",
          summary: "tests passed",
        },
      ],
    });
    expect(runner.commands.map((command) => command.command)).toEqual([
      "bun test",
      "git",
      "git",
      "git",
      "gh",
      "git",
      "gh",
      "gh",
    ]);
    expect(runner.commands).toContainEqual({
      kind: "run",
      command: "gh",
      args: ["auth", "setup-git", "--hostname", "github.com"],
      cwd: "/tmp/worktree",
    });
    const commit = runner.commands.find(
      (command) => command.kind === "run" && command.command === "git" && command.args.includes("commit"),
    );
    expect(commit).toMatchObject({
      args: expect.arrayContaining([
        "-c",
        "gpg.format=ssh",
        "user.signingKey=/tmp/codex_signing_key",
        "user.name=Tetherbox",
        "user.email=tetherbox@users.noreply.github.com",
        "commit",
        "-S",
        "-m",
        "Co-authored-by: Codex <codex@openai.com>",
      ]),
    });
  });

  test("updates an existing PR for the branch instead of creating a duplicate", async () => {
    const runner = new FakeRunner([
      { stdout: " M src/app.ts\n", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
    ]);
    runner.shellResults.push({ stdout: "tests passed\n", stderr: "" });
    runner.existingPullRequest = {
      url: "https://github.com/lucasilverentand/example/pull/42",
      number: 42,
    };

    const result = await finalizeSuccessfulRun(config, job, worktree, runner);
    const edit = runner.commands.find(
      (command) => command.kind === "run" && command.command === "gh" && command.args[0] === "pr" && command.args[1] === "edit",
    );
    const create = runner.commands.find(
      (command) => command.kind === "run" && command.command === "gh" && command.args[0] === "pr" && command.args[1] === "create",
    );

    expect(result).toMatchObject({
      status: "updated",
      url: "https://github.com/lucasilverentand/example/pull/42",
      number: 42,
    });
    expect(edit).toMatchObject({
      args: expect.arrayContaining(["pr", "edit", "42", "--repo", "lucasilverentand/example"]),
    });
    expect(create).toBeUndefined();
  });

  test("uses Git's configured signing key when the configured signing key is missing", async () => {
    const runner = new FakeRunner([
      { stdout: " M src/app.ts\n", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "https://github.com/lucasilverentand/example/pull/42\n", stderr: "" },
    ]);
    runner.shellResults.push({ stdout: "", stderr: "" });

    const result = await finalizeSuccessfulRun(signedConfig, job, worktree, runner);
    const commit = runner.commands.find(
      (command) => command.kind === "run" && command.command === "git" && command.args.includes("commit"),
    );

    expect(result.warnings).toEqual([
      "Git signing key not found at /tmp/codex_signing_key; trying Git's configured signing key.",
    ]);
    expect(commit?.kind).toBe("run");
    if (!commit || commit.kind !== "run") {
      throw new Error("Expected git commit command");
    }
    expect(commit.args).toContain("commit");
    expect(commit.args).toContain("-S");
    expect(commit.args).toContain("user.name=Tetherbox");
    expect(commit.args).toContain("user.email=tetherbox@users.noreply.github.com");
    expect(commit.args).toContain("Co-authored-by: Codex <codex@openai.com>");
    expect(commit.args).not.toContain("user.signingKey=/tmp/codex_signing_key");
  });

  test("uses Git's configured signing key when signing with the configured key fails", async () => {
    const runner = new FakeRunner([
      { stdout: " M src/app.ts\n", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "https://github.com/lucasilverentand/example/pull/42\n", stderr: "" },
    ]);
    runner.shellResults.push({ stdout: "", stderr: "" });
    runner.existingFiles.add("/tmp/codex_signing_key");
    runner.failSignedCommit = true;

    const result = await finalizeSuccessfulRun(signedConfig, job, worktree, runner);
    const commits = runner.commands.filter(
      (command) => command.kind === "run" && command.command === "git" && command.args.includes("commit"),
    );

    expect(result.warnings?.[0]).toContain(
      "Signed commit with /tmp/codex_signing_key failed; trying Git's configured signing key.",
    );
    expect(commits).toHaveLength(2);
    expect(commits[0]?.kind === "run" ? commits[0].args.includes("-S") : false).toBe(true);
    expect(commits[1]?.kind === "run" ? commits[1].args.includes("-S") : false).toBe(true);
    expect(commits[1]?.kind === "run" ? commits[1].args.includes("user.signingKey=/tmp/codex_signing_key") : true).toBe(
      false,
    );
  });

  test("classifies GitHub CLI authentication failures", async () => {
    const runner = new FakeRunner([
      { stdout: " M src/app.ts\n", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
    ]);
    runner.shellResults.push({ stdout: "", stderr: "" });
    runner.failRunCommand = "gh";
    runner.failRun = "gh: To get started with GitHub CLI, please run: gh auth login";

    await expect(finalizeSuccessfulRun(config, job, worktree, runner)).rejects.toBeInstanceOf(
      GitHubAuthenticationRequiredError,
    );
    expect(isGitHubAuthenticationFailure({ stdout: "", stderr: "HTTP 401: Bad credentials" })).toBe(true);
    expect(isGitHubAuthenticationFailure({ stdout: "", stderr: "repository not found" })).toBe(false);
  });

  test("classifies GitHub remote push authentication failures", async () => {
    const runner = new FakeRunner([
      { stdout: " M src/app.ts\n", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
    ]);
    runner.shellResults.push({ stdout: "", stderr: "" });
    runner.failRunCommand = "git";
    runner.failRunArgsIncludes = "push";
    runner.failRun = "git@github.com: Permission denied (publickey).";

    await expect(finalizeSuccessfulRun(config, job, worktree, runner)).rejects.toBeInstanceOf(
      GitHubAuthenticationRequiredError,
    );
  });

  test("parses pull request check output", () => {
    expect(parsePullRequestCheckOutput("build\tpass\t0m10s\thttps://example.test").status).toBe("passed");
    expect(parsePullRequestCheckOutput("build\tfail\t0m10s\thttps://example.test").status).toBe("failed");
    expect(parsePullRequestCheckOutput("no checks reported on the 'feature' branch").status).toBe("no_checks");
  });

  test("watches pull request checks with gh", async () => {
    const runner = new FakeRunner([{ stdout: "build\tpass\t0m10s\thttps://example.test\n", stderr: "" }]);

    const result = await watchPullRequestChecks("lucasilverentand/example", 42, "/tmp/worktree", runner);

    expect(result.status).toBe("passed");
    expect(runner.commands).toEqual([
      {
        kind: "run",
        command: "gh",
        args: ["pr", "checks", "42", "--repo", "lucasilverentand/example", "--watch"],
        cwd: "/tmp/worktree",
      },
    ]);
  });

  test("retries when GitHub has not attached pull request checks yet", async () => {
    const runner = new FakeRunner([{ stdout: "build\tpass\t0m10s\thttps://example.test\n", stderr: "" }]);
    runner.failRunMessages.push("no checks reported on the 'feature' branch");
    const delays: number[] = [];

    const result = await watchPullRequestChecks("lucasilverentand/example", 42, "/tmp/worktree", runner, {
      noChecksRetries: 2,
      noChecksRetryDelayMs: 5,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(result.status).toBe("passed");
    expect(delays).toEqual([5]);
    expect(runner.commands.filter((command) => command.command === "gh")).toHaveLength(2);
  });

  test("records absent pull request checks from gh errors", async () => {
    const runner = new FakeRunner([]);
    runner.failRunMessages.push(
      "no checks reported on the 'feature' branch",
      "no checks reported on the 'feature' branch",
    );

    const result = await watchPullRequestChecks("lucasilverentand/example", 42, "/tmp/worktree", runner, {
      noChecksRetries: 1,
      noChecksRetryDelayMs: 5,
      sleep: async () => {},
    });

    expect(result).toMatchObject({
      status: "no_checks",
      summary: "No GitHub checks were reported for the pull request.",
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

const signedConfig: BridgeConfig = {
  ...config,
  git: { signingKeyPath: "/tmp/codex_signing_key" },
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
  failRun?: string;
  failRunMessages: string[] = [];
  failRunCommand?: string;
  failRunArgsIncludes?: string;
  failSignedCommit = false;
  existingFiles = new Set<string>();
  existingPullRequest?: { url?: string; number?: number };
  shellResults: CommandResult[] = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    this.commands.push({ kind: "run", command, args, cwd });
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      if (!this.existingPullRequest) {
        throw new Error("no pull request found");
      }
      return { stdout: JSON.stringify(this.existingPullRequest), stderr: "" };
    }
    const queuedFailure = this.failRunMessages.shift();
    if (queuedFailure) {
      throw new Error(queuedFailure);
    }
    if (this.failSignedCommit && command === "git" && args.includes("commit") && args.includes("-S")) {
      this.failSignedCommit = false;
      throw new Error("signing failed");
    }
    if (
      this.failRun &&
      (!this.failRunCommand || this.failRunCommand === command) &&
      (!this.failRunArgsIncludes || args.includes(this.failRunArgsIncludes))
    ) {
      throw new Error(this.failRun);
    }
    return this.next();
  }

  async runShell(command: string, cwd: string): Promise<CommandResult> {
    this.commands.push({ kind: "shell", command, cwd });
    if (this.failShell) {
      throw new Error("validation failed");
    }
    return this.shellResults.shift() ?? { stdout: "", stderr: "" };
  }

  async fileExists(path: string): Promise<boolean> {
    return this.existingFiles.has(path);
  }

  private next(): CommandResult {
    const result = this.results.shift();
    if (!result) {
      throw new Error("Unexpected command");
    }
    return result;
  }
}
