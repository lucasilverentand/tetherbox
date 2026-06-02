import { createHmac, timingSafeEqual } from "node:crypto";
import type { BridgeConfig, LinearAgentSessionEvent, LinearIssueContext } from "./types";

export type LinearActivityContent =
  | { type: "thought"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

export interface LinearPlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

export interface LinearExternalUrl {
  label: string;
  url: string;
}

export interface LinearRepositorySuggestion {
  hostname?: string;
  repositoryFullName: string;
  confidence: number;
}

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

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
  return firstText(
    event.agentSession?.promptContext,
    event.promptContext,
    event.agentActivity?.body,
    event.agentActivity?.content?.body,
    event.agentSession?.prompt,
    event.prompt,
  );
}

export async function postLinearActivity(
  config: BridgeConfig,
  agentSessionId: string,
  content: LinearActivityContent,
): Promise<void> {
  const token = getLinearApiKey(config);
  if (!token) {
    logLinearFallback("agentActivityCreate", { agentSessionId, content });
    return;
  }

  await linearGraphql(token, {
    query: `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
        agentActivity {
          id
        }
      }
    }`,
    variables: {
      input: {
        agentSessionId,
        content,
      },
    },
  });
}

export async function updateLinearAgentSession(
  config: BridgeConfig,
  agentSessionId: string,
  input: {
    plan?: LinearPlanStep[];
    externalUrls?: LinearExternalUrl[];
    addedExternalUrls?: LinearExternalUrl[];
    removedExternalUrls?: LinearExternalUrl[];
  },
): Promise<void> {
  const token = getLinearApiKey(config);
  if (!token) {
    logLinearFallback("agentSessionUpdate", { agentSessionId, input });
    return;
  }

  await linearGraphql(token, {
    query: `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
      agentSessionUpdate(id: $id, input: $input) {
        success
      }
    }`,
    variables: {
      id: agentSessionId,
      input,
    },
  });
}

export async function suggestLinearRepositories(
  config: BridgeConfig,
  issueId: string | undefined,
  agentSessionId: string,
): Promise<LinearRepositorySuggestion[]> {
  const token = getLinearApiKey(config);
  if (!token || !issueId || config.repos.length === 0) {
    logLinearFallback("issueRepositorySuggestions", { issueId, agentSessionId });
    return [];
  }

  const payload = await linearGraphql<{
    issueRepositorySuggestions?: {
      suggestions?: LinearRepositorySuggestion[];
    };
  }>(token, {
    query: `query IssueRepositorySuggestions(
      $issueId: String!
      $agentSessionId: String!
      $candidateRepositories: [CandidateRepository!]!
    ) {
      issueRepositorySuggestions(
        issueId: $issueId
        agentSessionId: $agentSessionId
        candidateRepositories: $candidateRepositories
      ) {
        suggestions {
          hostname
          repositoryFullName
          confidence
        }
      }
    }`,
    variables: {
      issueId,
      agentSessionId,
      candidateRepositories: config.repos.map((repo) => ({
        hostname: "github.com",
        repositoryFullName: repo.github,
      })),
    },
  });

  return payload.issueRepositorySuggestions?.suggestions ?? [];
}

export function statusExternalUrl(config: BridgeConfig, jobId: string): LinearExternalUrl | undefined {
  if (!config.server.publicUrl) {
    return undefined;
  }

  return {
    label: "Tetherbox job",
    url: `${config.server.publicUrl.replace(/\/$/, "")}/api/status#${encodeURIComponent(jobId)}`,
  };
}

function getLinearApiKey(config: BridgeConfig): string | undefined {
  const envName = config.linear.apiKeyEnv;
  return envName ? process.env[envName] : undefined;
}

async function linearGraphql<T>(
  token: string,
  body: { query: string; variables: Record<string, unknown> },
): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Linear GraphQL returned HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    errors?: { message?: string }[];
    data?: T;
  };
  if (payload.errors?.length) {
    throw new Error(`Linear GraphQL error: ${payload.errors.map((error) => error.message ?? "unknown").join("; ")}`);
  }

  return (payload.data ?? ({} as T)) as T;
}

function logLinearFallback(operation: string, payload: unknown): void {
  console.log(JSON.stringify({ source: "linear.graphql.fallback", operation, payload }));
}

function firstText(...values: Array<string | undefined>): string {
  return values.find((value) => value?.trim()) ?? "";
}
