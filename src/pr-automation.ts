import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import type { BridgeConfig, RoutedJob } from "./types";
import type { WorktreeInfo } from "./worktree-manager";

export interface PullRequestResult {
  status: "no_changes" | "created" | "updated";
  url?: string;
  number?: number;
  warnings?: string[];
  validation?: ValidationCommandResult[];
}

interface ExistingPullRequest {
  url?: string;
  number?: number;
}

export interface PullRequestCheckResult {
  status: "passed" | "failed" | "no_checks";
  summary: string;
  output: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface ValidationCommandResult extends CommandResult {
  command: string;
  status: "passed" | "failed";
  summary: string;
}

export interface CommandRunner {
  run(command: string, args: string[], cwd: string): Promise<CommandResult>;
  runShell(command: string, cwd: string): Promise<CommandResult>;
  fileExists?(path: string): Promise<boolean>;
}

export class CommandExecutionError extends Error {
  constructor(
    message: string,
    readonly result: CommandResult,
  ) {
    super(message);
    this.name = "CommandExecutionError";
  }
}

export class ValidationFailedError extends Error {
  constructor(readonly results: ValidationCommandResult[]) {
    const failed = results.find((result) => result.status === "failed");
    super(`Validation command failed: ${failed?.command ?? "unknown"}`);
    this.name = "ValidationFailedError";
  }
}

export async function finalizeSuccessfulRun(
  config: BridgeConfig,
  job: RoutedJob,
  worktree: WorktreeInfo,
  runner: CommandRunner = new ProcessCommandRunner(),
): Promise<PullRequestResult> {
  const warnings: string[] = [];
  const validation = await runValidationCommands(job, worktree, runner);

  const status = await runner.run("git", ["status", "--porcelain"], worktree.path);
  if (!status.stdout.trim()) {
    return { status: "no_changes", warnings, validation };
  }

  await runner.run("git", ["add", "--all"], worktree.path);
  await createCommit(config, job, worktree, runner, warnings);
  await runner.run("git", ["push", "-u", "origin", worktree.branchName], worktree.path);
  const existing = await findExistingPullRequest(job.repo.github, worktree, runner);
  if (existing) {
    await runner.run(
      "gh",
      [
        "pr",
        "edit",
        String(existing.number ?? existing.url ?? worktree.branchName),
        "--repo",
        job.repo.github,
        "--title",
        commitTitle(job),
        "--body",
        pullRequestBody(job, config),
      ],
      worktree.path,
    );
    return {
      status: "updated",
      url: existing.url,
      number: existing.number,
      warnings,
      validation,
    };
  }

  const created = await runner.run(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      job.repo.github,
      "--base",
      job.repo.defaultBase,
      "--head",
      worktree.branchName,
      "--title",
      commitTitle(job),
      "--body",
      pullRequestBody(job, config),
    ],
    worktree.path,
  );

  const url = created.stdout.trim().split(/\s+/).find((value) => value.startsWith("https://"));
  return {
    status: "created",
    url,
    number: url ? Number(url.match(/\/pull\/(\d+)/)?.[1]) || undefined : undefined,
    warnings,
    validation,
  };
}

export async function watchPullRequestChecks(
  repo: string,
  prNumber: number,
  cwd: string,
  runner: CommandRunner = new ProcessCommandRunner(),
): Promise<PullRequestCheckResult> {
  try {
    const result = await runner.run("gh", ["pr", "checks", String(prNumber), "--repo", repo, "--watch"], cwd);
    return parsePullRequestCheckOutput(result.stdout || result.stderr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return parsePullRequestCheckOutput(message);
  }
}

export function parsePullRequestCheckOutput(output: string): PullRequestCheckResult {
  const normalized = output.trim();
  if (/no checks reported/i.test(normalized)) {
    return {
      status: "no_checks",
      summary: "No GitHub checks were reported for the pull request.",
      output: normalized,
    };
  }

  if (/(^|\s)(fail|failing|failure|cancelled|canceled|timed_out|timed out)(\s|$)/i.test(normalized)) {
    return {
      status: "failed",
      summary: "GitHub pull request checks failed.",
      output: normalized,
    };
  }

  return {
    status: "passed",
    summary: "GitHub pull request checks passed.",
    output: normalized,
  };
}

class ProcessCommandRunner implements CommandRunner {
  async run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    return runProcess(command, args, cwd, false);
  }

  async runShell(command: string, cwd: string): Promise<CommandResult> {
    return runProcess(command, [], cwd, true);
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}

async function createCommit(
  config: BridgeConfig,
  job: RoutedJob,
  worktree: WorktreeInfo,
  runner: CommandRunner,
  warnings: string[],
): Promise<void> {
  const unsignedArgs = commitArgs(job);
  const signingKeyPath = expandHome(config.git?.signingKeyPath);

  if (!signingKeyPath) {
    await runner.run("git", unsignedArgs, worktree.path);
    return;
  }

  if (!(await fileExists(runner, signingKeyPath))) {
    warnings.push(`Git signing key not found at ${signingKeyPath}; created an unsigned commit.`);
    await runner.run("git", unsignedArgs, worktree.path);
    return;
  }

  try {
    await runner.run(
      "git",
      ["-c", "gpg.format=ssh", "-c", `user.signingKey=${signingKeyPath}`, ...commitArgs(job, true)],
      worktree.path,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Signed commit failed; created an unsigned commit instead. ${message}`);
    await runner.run("git", unsignedArgs, worktree.path);
  }
}

function commitArgs(job: RoutedJob, sign = false): string[] {
  return [
    "commit",
    ...(sign ? ["-S"] : []),
    "-m",
    commitTitle(job),
    "-m",
    commitBody(job),
    "-m",
    "Co-authored-by: Codex <codex@openai.com>",
  ];
}

async function findExistingPullRequest(
  repo: string,
  worktree: WorktreeInfo,
  runner: CommandRunner,
): Promise<ExistingPullRequest | undefined> {
  try {
    const result = await runner.run(
      "gh",
      ["pr", "view", worktree.branchName, "--repo", repo, "--json", "url,number"],
      worktree.path,
    );
    const parsed = JSON.parse(result.stdout) as ExistingPullRequest;
    return parsed.url || parsed.number ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function runValidationCommands(
  job: RoutedJob,
  worktree: WorktreeInfo,
  runner: CommandRunner,
): Promise<ValidationCommandResult[]> {
  const results: ValidationCommandResult[] = [];

  for (const command of job.repo.testCommands ?? []) {
    try {
      const result = await runner.runShell(command, worktree.path);
      results.push(validationResult(command, "passed", result));
    } catch (error) {
      results.push(validationResult(command, "failed", commandResultFromError(error)));
      throw new ValidationFailedError(results);
    }
  }

  return results;
}

function validationResult(
  command: string,
  status: ValidationCommandResult["status"],
  result: CommandResult,
): ValidationCommandResult {
  return {
    command,
    status,
    stdout: result.stdout,
    stderr: result.stderr,
    summary: summarizeCommandOutput(result),
  };
}

function commandResultFromError(error: unknown): CommandResult {
  if (error instanceof CommandExecutionError) {
    return error.result;
  }

  return {
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  };
}

function summarizeCommandOutput(result: CommandResult): string {
  const output = [result.stdout, result.stderr].filter((value) => value.trim()).join("\n").trim();
  if (!output) {
    return "No output.";
  }

  const lines = output.split(/\r?\n/).slice(-8).join("\n");
  return lines.length > 2_000 ? `${lines.slice(0, 1_997)}...` : lines;
}

async function fileExists(runner: CommandRunner, path: string): Promise<boolean> {
  if (runner.fileExists) {
    return runner.fileExists(path);
  }

  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return `${homedir()}${path.slice(1)}`;
  }
  return path;
}

function commitTitle(job: RoutedJob): string {
  const title = job.issue.title?.trim() || "implement linear issue";
  return `feat: ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
}

function commitBody(job: RoutedJob): string {
  return [
    job.issue.identifier ? `Linear: ${job.issue.identifier}` : undefined,
    job.issue.url ? `Issue URL: ${job.issue.url}` : undefined,
    "Implemented from a Tetherbox Linear Agent Session.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function pullRequestBody(job: RoutedJob, config: BridgeConfig): string {
  const testCommands = job.repo.testCommands?.length
    ? job.repo.testCommands.map((command) => `- \`${command}\``).join("\n")
    : "- No configured validation commands";

  return [
    "## Summary",
    "",
    `- Implements ${job.issue.identifier ?? "the assigned Linear issue"} from a local Tetherbox run.`,
    "",
    "## Validation",
    "",
    testCommands,
    "",
    "## Linear",
    "",
    job.issue.url ? `- ${job.issue.url}` : `- ${job.issue.identifier ?? job.sessionId}`,
    "",
    "## Tetherbox",
    "",
    `- Daemon: ${config.server.publicUrl ?? "local"}`,
  ].join("\n");
}

async function runProcess(command: string, args: string[], cwd: string, shell: boolean): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new CommandExecutionError(`${command} ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`, {
            stdout,
            stderr,
          }),
        );
      }
    });
  });
}
