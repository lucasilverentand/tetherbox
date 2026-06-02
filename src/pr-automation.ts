import { spawn } from "node:child_process";
import type { BridgeConfig, RoutedJob } from "./types";
import type { WorktreeInfo } from "./worktree-manager";

export interface PullRequestResult {
  status: "no_changes" | "created";
  url?: string;
  number?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], cwd: string): Promise<CommandResult>;
  runShell(command: string, cwd: string): Promise<CommandResult>;
}

export async function finalizeSuccessfulRun(
  config: BridgeConfig,
  job: RoutedJob,
  worktree: WorktreeInfo,
  runner: CommandRunner = new ProcessCommandRunner(),
): Promise<PullRequestResult> {
  for (const command of job.repo.testCommands ?? []) {
    await runner.runShell(command, worktree.path);
  }

  const status = await runner.run("git", ["status", "--porcelain"], worktree.path);
  if (!status.stdout.trim()) {
    return { status: "no_changes" };
  }

  await runner.run("git", ["add", "--all"], worktree.path);
  await runner.run(
    "git",
    [
      "commit",
      "-S",
      "-m",
      commitTitle(job),
      "-m",
      commitBody(job),
      "-m",
      "Co-authored-by: Codex <codex@openai.com>",
    ],
    worktree.path,
  );
  await runner.run("git", ["push", "-u", "origin", worktree.branchName], worktree.path);
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
  };
}

class ProcessCommandRunner implements CommandRunner {
  async run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    return runProcess(command, args, cwd, false);
  }

  async runShell(command: string, cwd: string): Promise<CommandResult> {
    return runProcess(command, [], cwd, true);
  }
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
        reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}
