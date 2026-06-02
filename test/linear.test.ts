import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { getIssueContext, getPrompt, getSessionId, parseLinearAgentEvent, verifyLinearSignature } from "../src/linear";

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
});
