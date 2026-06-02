import type { AppliedPolicy, BridgeConfig, LinearIssueContext, RepoMapping } from "./types";

export function applyPolicy(config: BridgeConfig, issue: LinearIssueContext, repo: RepoMapping): AppliedPolicy {
  for (const rule of config.policies) {
    if (rule.labels?.length && !rule.labels.some((label) => issue.labels.includes(label))) {
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
