import { createHmac, timingSafeEqual } from "node:crypto";
import type { LinearAgentSessionEvent, LinearIssueContext } from "./types";

export function verifyLinearSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const signatureBuffer = Buffer.from(signature, "hex");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

export function parseLinearAgentEvent(rawBody: string): LinearAgentSessionEvent {
  const parsed = JSON.parse(rawBody) as LinearAgentSessionEvent;
  return parsed;
}

export function getIssueContext(event: LinearAgentSessionEvent): LinearIssueContext {
  const issue = event.agentSession?.issue ?? event.issue;
  return {
    labels: [],
    ...issue,
    labels: issue?.labels ?? [],
  };
}

export function getSessionId(event: LinearAgentSessionEvent): string {
  const id = event.agentSession?.id;
  if (!id) {
    throw new Error("Linear event did not include agentSession.id");
  }
  return id;
}

export function getPrompt(event: LinearAgentSessionEvent): string {
  return event.agentSession?.prompt ?? event.prompt ?? "";
}

export async function postLinearActivity(message: string): Promise<void> {
  // Placeholder for the Linear GraphQL activity API.
  // Keeping this as a single seam makes it easy to swap in the generated Linear client.
  console.log(JSON.stringify({ source: "linear.activity", message }));
}
