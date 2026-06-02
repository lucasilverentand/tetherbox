import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  getIssueContext,
  getPrompt,
  getSessionId,
  parseLinearAgentEvent,
  postLinearActivity,
  statusExternalUrl,
  updateLinearAgentSession,
  verifyLinearSignature,
} from "../src/linear";
import type { BridgeConfig } from "../src/types";

describe("Linear webhook handling", () => {
  test("verifies Linear HMAC signatures", () => {
    const rawBody = JSON.stringify({ type: "AgentSessionEvent", agentSession: { id: "sess_1" } });
    const secret = "test-secret";
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

    expect(verifyLinearSignature(rawBody, signature, secret)).toBe(true);
    expect(verifyLinearSignature(rawBody, "bad", secret)).toBe(false);
  });

  test("extracts session, prompt, and issue context", () => {
    const event = parseLinearAgentEvent(
      JSON.stringify({
        agentSession: {
          id: "sess_1",
          prompt: "Fix this in lucasilverentand/example",
          issue: {
            identifier: "ENG-123",
            title: "Fix checkout",
            teamKey: "ENG",
            labels: ["docs"],
          },
        },
      }),
    );

    expect(getSessionId(event)).toBe("sess_1");
    expect(getPrompt(event)).toContain("Fix this");
    expect(getIssueContext(event).labels).toEqual(["docs"]);
  });

  test("prefers promptContext and prompted activity bodies", () => {
    const created = parseLinearAgentEvent(
      JSON.stringify({
        agentSession: {
          id: "sess_1",
          promptContext: "<issue><title>Fix checkout</title></issue>",
          prompt: "fallback",
        },
      }),
    );
    const prompted = parseLinearAgentEvent(
      JSON.stringify({
        agentSession: { id: "sess_1", promptContext: "" },
        agentActivity: { body: "Please also add tests" },
      }),
    );

    expect(getPrompt(created)).toContain("<issue>");
    expect(getPrompt(prompted)).toBe("Please also add tests");
  });

  test("posts agent activities through Linear GraphQL", async () => {
    const calls: unknown[] = [];
    const restore = mockFetch(calls);
    process.env.LINEAR_API_KEY = "lin_test";

    try {
      await postLinearActivity(config, "sess_1", {
        type: "thought",
        body: "Queued local work.",
      });
    } finally {
      restore();
      delete process.env.LINEAR_API_KEY;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      headers: {
        Authorization: "Bearer lin_test",
      },
      body: {
        variables: {
          input: {
            agentSessionId: "sess_1",
            content: {
              type: "thought",
              body: "Queued local work.",
            },
          },
        },
      },
    });
  });

  test("updates agent session plans and external URLs", async () => {
    const calls: unknown[] = [];
    const restore = mockFetch(calls);
    process.env.LINEAR_API_KEY = "lin_test";

    try {
      await updateLinearAgentSession(config, "sess_1", {
        externalUrls: [{ label: "Tetherbox job", url: "https://bridge.example/status#job-1" }],
        plan: [{ content: "Run Codex locally", status: "inProgress" }],
      });
    } finally {
      restore();
      delete process.env.LINEAR_API_KEY;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      body: {
        variables: {
          id: "sess_1",
          input: {
            externalUrls: [{ label: "Tetherbox job", url: "https://bridge.example/status#job-1" }],
            plan: [{ content: "Run Codex locally", status: "inProgress" }],
          },
        },
      },
    });
  });

  test("builds public status URLs when configured", () => {
    expect(statusExternalUrl(config, "job/1")?.url).toBe("https://bridge.example/api/status#job%2F1");
    expect(statusExternalUrl({ ...config, server: { host: "127.0.0.1", port: 8787 } }, "job/1")).toBeUndefined();
  });
});

const config: BridgeConfig = {
  server: { host: "127.0.0.1", port: 8787, publicUrl: "https://bridge.example" },
  linear: { webhookSecretEnv: "LINEAR_WEBHOOK_SECRET", apiKeyEnv: "LINEAR_API_KEY" },
  codex: { bin: "codex", sandbox: "workspace-write" },
  repos: [],
  policies: [],
};

function mockFetch(calls: unknown[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      headers: init?.headers,
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}
