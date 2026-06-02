import type { BridgeConfig, LinearIssueContext, RepoMapping } from "./types";

export function routeRepo(config: BridgeConfig, issue: LinearIssueContext, prompt: string): RepoMapping {
  const explicit = findExplicitRepo(config.repos, prompt);
  if (explicit) {
    return explicit;
  }

  const teamMatch = config.repos.find((repo) => issue.teamKey && repo.linearTeams.includes(issue.teamKey));
  if (teamMatch) {
    return teamMatch;
  }

  if (config.repos.length === 1) {
    return config.repos[0]!;
  }

  throw new Error("Could not route Linear issue to a local repository");
}

function findExplicitRepo(repos: RepoMapping[], prompt: string): RepoMapping | undefined {
  const lowered = prompt.toLowerCase();
  return repos.find((repo) => lowered.includes(repo.github.toLowerCase()));
}
