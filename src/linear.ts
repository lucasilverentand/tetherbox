import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { BridgeConfig, LinearAgentSessionEvent, LinearIssueContext } from "./types";
import type { LinearInstallationRecord } from "./state-store";

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
const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const DEFAULT_OAUTH_SCOPES = ["read", "write", "app:assignable", "app:mentionable"];

export interface LinearTokenStore {
  getLinearInstallation(workspaceId?: string): LinearInstallationRecord | undefined;
  saveLinearInstallation(record: {
    workspaceId: string;
    appUserId?: string;
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    scope?: string;
    expiresAt?: string;
  }): void;
}

export interface LinearOAuthStateStore {
  createLinearOAuthState(state: string, redirectUri: string, expiresAt: string): void;
  consumeLinearOAuthState(state: string, now?: Date): { redirectUri: string } | undefined;
}

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
  tokenStore?: LinearTokenStore,
): Promise<void> {
  const token = await getLinearAccessToken(config, tokenStore);
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
  tokenStore?: LinearTokenStore,
): Promise<void> {
  const token = await getLinearAccessToken(config, tokenStore);
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
  tokenStore?: LinearTokenStore,
): Promise<LinearRepositorySuggestion[]> {
  const token = await getLinearAccessToken(config, tokenStore);
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

export function buildLinearOAuthAuthorizationUrl(
  config: BridgeConfig,
  stateStore: LinearOAuthStateStore,
  state = randomState(),
  now = new Date(),
): URL {
  const clientId = getRequiredConfigEnv(config.linear.oauthClientIdEnv, "linear.oauthClientIdEnv");
  const redirectUri = getOAuthRedirectUri(config);
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  stateStore.createLinearOAuthState(state, redirectUri, expiresAt);

  const url = new URL(LINEAR_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (config.linear.oauthScopes ?? DEFAULT_OAUTH_SCOPES).join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("actor", "app");
  return url;
}

export async function completeLinearOAuthCallback(
  config: BridgeConfig,
  stateStore: LinearOAuthStateStore & LinearTokenStore,
  params: URLSearchParams,
): Promise<LinearInstallationRecord> {
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    throw new Error("Linear OAuth callback requires code and state");
  }

  const oauthState = stateStore.consumeLinearOAuthState(state);
  if (!oauthState) {
    throw new Error("Invalid or expired Linear OAuth state");
  }

  const token = await exchangeLinearOAuthToken(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: oauthState.redirectUri,
  });
  const viewer = await fetchLinearViewer(token.access_token);
  const installation = {
    workspaceId: "default",
    appUserId: viewer.id,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    tokenType: token.token_type,
    scope: normalizeScope(token.scope),
    expiresAt: expiresAt(token.expires_in),
  };
  stateStore.saveLinearInstallation(installation);
  return stateStore.getLinearInstallation("default")!;
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

async function getLinearAccessToken(config: BridgeConfig, tokenStore?: LinearTokenStore): Promise<string | undefined> {
  const envName = config.linear.apiKeyEnv;
  const envToken = envName ? process.env[envName] : undefined;
  if (envToken) {
    return envToken;
  }

  const installation = tokenStore?.getLinearInstallation("default");
  if (!installation) {
    return undefined;
  }

  if (!isExpired(installation.expiresAt)) {
    return installation.accessToken;
  }

  if (!installation.refreshToken) {
    return installation.accessToken;
  }

  const refreshed = await exchangeLinearOAuthToken(config, {
    grant_type: "refresh_token",
    refresh_token: installation.refreshToken,
  });
  tokenStore?.saveLinearInstallation({
    workspaceId: installation.workspaceId,
    appUserId: installation.appUserId,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    tokenType: refreshed.token_type,
    scope: normalizeScope(refreshed.scope),
    expiresAt: expiresAt(refreshed.expires_in),
  });
  return refreshed.access_token;
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

async function exchangeLinearOAuthToken(
  config: BridgeConfig,
  params: Record<string, string>,
): Promise<{
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string | string[];
  refresh_token?: string;
}> {
  const clientId = getRequiredConfigEnv(config.linear.oauthClientIdEnv, "linear.oauthClientIdEnv");
  const clientSecret = getRequiredConfigEnv(config.linear.oauthClientSecretEnv, "linear.oauthClientSecretEnv");
  const body = new URLSearchParams({
    ...params,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Linear OAuth token exchange failed with HTTP ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in?: number;
    scope?: string | string[];
    refresh_token?: string;
  };
}

async function fetchLinearViewer(accessToken: string): Promise<{ id?: string }> {
  const data = await linearGraphql<{ viewer?: { id?: string } }>(accessToken, {
    query: `query Viewer { viewer { id } }`,
    variables: {},
  });
  return data.viewer ?? {};
}

function getOAuthRedirectUri(config: BridgeConfig): string {
  if (config.linear.oauthRedirectUri) {
    return config.linear.oauthRedirectUri;
  }
  if (!config.server.publicUrl) {
    throw new Error("Config must include linear.oauthRedirectUri or server.publicUrl for Linear OAuth");
  }
  return `${config.server.publicUrl.replace(/\/$/, "")}/oauth/linear/callback`;
}

function getRequiredConfigEnv(name: string | undefined, field: string): string {
  if (!name) {
    throw new Error(`Config must include ${field}`);
  }
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function randomState(): string {
  return randomUUID();
}

function normalizeScope(scope: string | string[] | undefined): string {
  return Array.isArray(scope) ? scope.join(" ") : scope ?? "";
}

function expiresAt(expiresIn: number | undefined): string | undefined {
  return expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
}

function isExpired(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return Date.parse(value) <= Date.now() + 60_000;
}
