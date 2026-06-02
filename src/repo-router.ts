import { suggestLinearRepositories, type LinearTokenStore } from "./linear";
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

export async function routeRepoForSession(
  config: BridgeConfig,
  issue: LinearIssueContext,
  prompt: string,
  sessionId: string,
  tokenStore?: LinearTokenStore,
): Promise<RepoMapping> {
  const explicit = findExplicitRepo(config.repos, prompt);
  if (explicit) {
    return explicit;
  }

  const suggested = await findSuggestedRepo(config, issue, sessionId, tokenStore);
  if (suggested) {
    return suggested;
  }

  return routeRepo(config, issue, prompt);
}

export function findExplicitRepo(repos: RepoMapping[], prompt: string): RepoMapping | undefined {
  const lowered = prompt.toLowerCase();
  return repos.find((repo) => lowered.includes(repo.github.toLowerCase()));
}

async function findSuggestedRepo(
  config: BridgeConfig,
  issue: LinearIssueContext,
  sessionId: string,
  tokenStore?: LinearTokenStore,
): Promise<RepoMapping | undefined> {
  const minimumConfidence = config.linear.repositorySuggestionMinConfidence ?? 0.2;

  try {
    const suggestions = await suggestLinearRepositories(config, issue.id, sessionId, tokenStore);
    const best = suggestions
      .filter((suggestion) => suggestion.confidence >= minimumConfidence)
      .sort((left, right) => right.confidence - left.confidence)[0];

    return config.repos.find((repo) => repo.github.toLowerCase() === best?.repositoryFullName.toLowerCase());
  } catch {
    return undefined;
  }
}
