import type { AppliedPolicy, BridgeConfig, LinearIssueContext, RepoMapping } from "./types";

export interface PolicyEvaluationContext {
  prompt?: string;
}

export function applyPolicy(
  config: BridgeConfig,
  issue: LinearIssueContext,
  repo: RepoMapping,
  context: PolicyEvaluationContext = {},
): AppliedPolicy {
  for (const rule of config.policies) {
    if (!matchesLabels(rule.labels, issue.labels)) {
      continue;
    }
    if (!matchesAny(rule.repos, [repo.github])) {
      continue;
    }
    if (!matchesAny(rule.teams, issue.teamKey ? [issue.teamKey] : [])) {
      continue;
    }
    if (!matchesPriority(rule.priorities, issue.priority)) {
      continue;
    }
    if (!matchesPaths(rule.paths, issue, context.prompt)) {
      continue;
    }

    return {
      ruleName: rule.name,
      decision: rule.decision,
      sandbox: rule.sandbox ?? config.codex.sandbox,
    };
  }

  return {
    ruleName: "default-require-approval",
    decision: "require_approval",
    sandbox: config.codex.sandbox,
  };
}

function matchesLabels(ruleLabels: string[] | undefined, issueLabels: string[]): boolean {
  return matchesAny(ruleLabels, issueLabels);
}

function matchesAny(ruleValues: string[] | undefined, candidateValues: string[]): boolean {
  if (!ruleValues?.length) {
    return true;
  }

  const candidates = new Set(candidateValues.map(normalize));
  return ruleValues.some((value) => candidates.has(normalize(value)));
}

function matchesPriority(rulePriorities: number[] | undefined, issuePriority: LinearIssueContext["priority"]): boolean {
  if (!rulePriorities?.length) {
    return true;
  }

  const value = typeof issuePriority === "number" ? issuePriority : issuePriority?.value;
  return typeof value === "number" && rulePriorities.includes(value);
}

function matchesPaths(rulePaths: string[] | undefined, issue: LinearIssueContext, prompt?: string): boolean {
  if (!rulePaths?.length) {
    return true;
  }

  const paths = extractPaths([issue.title, issue.description, prompt].filter(Boolean).join("\n"));
  return rulePaths.some((pattern) => paths.some((path) => globMatches(pattern, path)));
}

function extractPaths(text: string): string[] {
  return [...text.matchAll(/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g)].map((match) =>
    match[0].replace(/[),.;:]+$/g, ""),
  );
}

function globMatches(pattern: string, path: string): boolean {
  const expression = pattern
    .split("/")
    .map((part) => {
      if (part === "**") {
        return "(?:.*)";
      }
      return part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
    })
    .join("/");
  return new RegExp(`^${expression}$`, "i").test(path);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
