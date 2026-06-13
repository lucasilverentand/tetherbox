import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { BridgeConfig, DaemonState, JobRecord, LinearIssueContext, RoutedJob } from "./types";

export interface WorktreeInfo {
  branchName: string;
  path: string;
}

export interface GarbageCollectionResult {
  removed: WorktreeInfo[];
  skipped: WorktreeInfo[];
}

const ACTIVE_STATUSES = new Set<JobRecord["status"]>(["queued", "running", "waiting_approval"]);

export function branchNameForIssue(issue: LinearIssueContext): string {
  const key = slugify(issue.identifier ?? "linear-job");
  const slug = slugify(issue.title ?? "work");
  const branchName = `${key}-${slug}`;

  if (branchName.startsWith("codex/") || branchName.startsWith("claude/")) {
    throw new Error(`Refusing reserved branch prefix in ${branchName}`);
  }

  return branchName;
}

export function branchNameForJob(job: RoutedJob): string {
  const base = branchNameForIssue(job.issue);
  const suffix = branchSuffixForJob(job.id);
  return `${base}-${suffix}`;
}

export function worktreePathForJob(config: BridgeConfig, job: RoutedJob): string {
  return join(worktreeRoot(config), safePathSegment(job.id));
}

export function worktreeRoot(config: BridgeConfig): string {
  return resolve(daemonStateDirectory(config), "worktrees");
}

export function daemonStateDirectory(config: BridgeConfig): string {
  return resolve(dirname(config.state?.path ?? "state/daemon.sqlite"));
}

export async function prepareWorktree(config: BridgeConfig, job: RoutedJob): Promise<WorktreeInfo> {
  const branchName = branchNameForJob(job);
  const path = worktreePathForJob(config, job);

  await mkdir(dirname(path), { recursive: true });
  await git(job.repo.localPath, ["fetch", "origin", job.repo.defaultBase]);

  const branchExists = await gitSucceeds(job.repo.localPath, ["rev-parse", "--verify", `refs/heads/${branchName}`]);
  const addArgs = branchExists
    ? ["worktree", "add", path, branchName]
    : ["worktree", "add", "-b", branchName, path, `origin/${job.repo.defaultBase}`];

  await git(job.repo.localPath, addArgs);
  return { branchName, path };
}

export async function garbageCollectWorktrees(
  config: BridgeConfig,
  state: DaemonState,
  now = new Date(),
): Promise<GarbageCollectionResult> {
  const removed: WorktreeInfo[] = [];
  const skipped: WorktreeInfo[] = [];
  const cutoff = now.getTime() - (config.state?.worktreeRetentionDays ?? 7) * 24 * 60 * 60 * 1000;
  const root = worktreeRoot(config);

  for (const job of state.jobs) {
    if (!job.branchName || !job.worktreePath || ACTIVE_STATUSES.has(job.status)) {
      continue;
    }

    const info = { branchName: job.branchName, path: job.worktreePath };
    const updatedAt = Date.parse(job.updatedAt);
    if (!isPathInside(root, job.worktreePath) || Number.isNaN(updatedAt) || updatedAt > cutoff) {
      skipped.push(info);
      continue;
    }

    const repo = config.repos.find((candidate) => candidate.github === job.repo);
    if (!repo) {
      skipped.push(info);
      continue;
    }

    await git(repo.localPath, ["worktree", "remove", "--force", job.worktreePath]);
    removed.push(info);
  }

  return { removed, skipped };
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "work"
  );
}

function safePathSegment(value: string): string {
  return slugify(value).slice(0, 80);
}

function branchSuffixForJob(jobId: string): string {
  const safeId = safePathSegment(jobId);
  return safeId.split("-").filter(Boolean).at(-1)?.slice(0, 12) || "job";
}

function isPathInside(root: string, path: string): boolean {
  const resolved = resolve(path);
  const pathFromRoot = relative(root, resolved);
  return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
      }
    });
  });
}
