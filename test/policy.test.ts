import { describe, expect, test } from "bun:test";
import { applyPolicy } from "../src/policy";
import { routeRepo } from "../src/repo-router";
import type { BridgeConfig } from "../src/types";

const config: BridgeConfig = {
  server: { host: "127.0.0.1", port: 8787 },
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
  policies: [
    {
      name: "docs-auto",
      labels: ["docs"],
      decision: "allow_auto",
      sandbox: "workspace-write",
    },
  ],
};

describe("policy and repo routing", () => {
  test("routes by explicit repo mention", () => {
    const repo = routeRepo(config, { teamKey: "OTHER", labels: [] }, "Use lucasilverentand/example");
    expect(repo.github).toBe("lucasilverentand/example");
  });

  test("routes by team key", () => {
    const repo = routeRepo(config, { teamKey: "ENG", labels: [] }, "");
    expect(repo.github).toBe("lucasilverentand/example");
  });

  test("applies matching policy rule", () => {
    const repo = config.repos[0]!;
    const decision = applyPolicy(config, { teamKey: "ENG", labels: ["docs"] }, repo);
    expect(decision.ruleName).toBe("docs-auto");
    expect(decision.decision).toBe("allow_auto");
  });

  test("requires approval by default", () => {
    const repo = config.repos[0]!;
    const decision = applyPolicy(config, { teamKey: "ENG", labels: [] }, repo);
    expect(decision.decision).toBe("require_approval");
  });
});
