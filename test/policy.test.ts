import { describe, expect, test } from "bun:test";
import { applyPolicy } from "../src/policy";
import { routeRepo, routeRepoForSession } from "../src/repo-router";
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

  test("routes by Linear repository suggestions before team fallback", async () => {
    const calls: unknown[] = [];
    const restore = mockFetch(calls, [
      { hostname: "github.com", repositoryFullName: "lucasilverentand/api", confidence: 0.9 },
    ]);
    process.env.LINEAR_API_KEY = "lin_test";

    try {
      const repo = await routeRepoForSession(routingConfig, { id: "issue-1", teamKey: "ENG", labels: [] }, "", "sess_1");
      expect(repo.github).toBe("lucasilverentand/api");
    } finally {
      restore();
      delete process.env.LINEAR_API_KEY;
    }

    expect(calls).toHaveLength(1);
  });

  test("keeps explicit repo mentions ahead of Linear suggestions", async () => {
    const repo = await routeRepoForSession(
      routingConfig,
      { id: "issue-1", teamKey: "ENG", labels: [] },
      "Use lucasilverentand/web",
      "sess_1",
    );
    expect(repo.github).toBe("lucasilverentand/web");
  });

  test("falls back when repository suggestions are unavailable", async () => {
    delete process.env.LINEAR_API_KEY;

    const repo = await routeRepoForSession(routingConfig, { id: "issue-1", teamKey: "ENG", labels: [] }, "", "sess_1");
    expect(repo.github).toBe("lucasilverentand/web");
  });

  test("applies matching policy rule", () => {
    const repo = config.repos[0]!;
    const decision = applyPolicy(config, { teamKey: "ENG", labels: ["docs"] }, repo);
    expect(decision.ruleName).toBe("docs-auto");
    expect(decision.decision).toBe("allow_auto");
  });

  test("evaluates policy rules deterministically in config order", () => {
    const repo = config.repos[0]!;
    const decision = applyPolicy(
      {
        ...config,
        policies: [
          { name: "first-docs", labels: ["docs"], decision: "require_approval" },
          { name: "second-docs", labels: ["docs"], decision: "allow_auto" },
        ],
      },
      { teamKey: "ENG", labels: ["docs"] },
      repo,
    );

    expect(decision.ruleName).toBe("first-docs");
    expect(decision.decision).toBe("require_approval");
  });

  test("matches policy rules by repo, team, and priority", () => {
    const repo = config.repos[0]!;
    const decision = applyPolicy(
      {
        ...config,
        policies: [
          {
            name: "oss-normal-plan",
            repos: ["lucasilverentand/example"],
            teams: ["OSS"],
            priorities: [3],
            decision: "allow_plan_only",
          },
        ],
      },
      { teamKey: "OSS", labels: [], priority: { value: 3, name: "Medium" } },
      repo,
    );

    expect(decision.ruleName).toBe("oss-normal-plan");
    expect(decision.decision).toBe("allow_plan_only");
  });

  test("requires all configured policy matchers to match", () => {
    const repo = config.repos[0]!;
    const decision = applyPolicy(
      {
        ...config,
        policies: [
          {
            name: "security-on-other-repo",
            labels: ["security"],
            repos: ["lucasilverentand/other"],
            decision: "deny",
          },
        ],
      },
      { teamKey: "ENG", labels: ["security"] },
      repo,
    );

    expect(decision.ruleName).toBe("default-require-approval");
    expect(decision.decision).toBe("require_approval");
  });

  test("matches policy paths from issue text and prompt context", () => {
    const repo = config.repos[0]!;
    const decision = applyPolicy(
      {
        ...config,
        policies: [
          {
            name: "infra-needs-approval",
            paths: ["infra/**", "terraform/**"],
            decision: "require_approval",
          },
        ],
      },
      {
        teamKey: "ENG",
        labels: [],
        description: "Update the release notes.",
      },
      repo,
      { prompt: "Please change infra/prod/service.yaml and explain the rollout." },
    );

    expect(decision.ruleName).toBe("infra-needs-approval");
    expect(decision.decision).toBe("require_approval");
  });

  test("requires approval by default", () => {
    const repo = config.repos[0]!;
    const decision = applyPolicy(config, { teamKey: "ENG", labels: [] }, repo);
    expect(decision.decision).toBe("require_approval");
  });
});

const routingConfig: BridgeConfig = {
  ...config,
  linear: {
    webhookSecretEnv: "LINEAR_WEBHOOK_SECRET",
    apiKeyEnv: "LINEAR_API_KEY",
    repositorySuggestionMinConfidence: 0.5,
  },
  repos: [
    {
      linearTeams: ["ENG"],
      github: "lucasilverentand/web",
      localPath: "/tmp/web",
      defaultBase: "main",
    },
    {
      linearTeams: ["API"],
      github: "lucasilverentand/api",
      localPath: "/tmp/api",
      defaultBase: "main",
    },
  ],
};

function mockFetch(
  calls: unknown[],
  suggestions: { hostname: string; repositoryFullName: string; confidence: number }[],
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      headers: init?.headers,
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ data: { issueRepositorySuggestions: { suggestions } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}
