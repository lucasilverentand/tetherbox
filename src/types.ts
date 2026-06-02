export type PolicyDecision = "allow_auto" | "allow_plan_only" | "require_approval" | "deny";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface BridgeConfig {
  server: {
    host: string;
    port: number;
    publicUrl?: string;
    operatorTokenEnv?: string;
  };
  state?: {
    path: string;
    worktreeRetentionDays?: number;
  };
  queue?: {
    concurrency?: number;
    shutdownGraceMs?: number;
    approvalTimeoutMs?: number;
  };
  linear: {
    webhookSecretEnv: string;
    webhookMaxAgeMs?: number;
    apiTimeoutMs?: number;
    agentActivityHistoryLimit?: number;
    apiKeyEnv?: string;
    repositorySuggestionMinConfidence?: number;
    reviewStateName?: string;
    oauthClientIdEnv?: string;
    oauthClientSecretEnv?: string;
    oauthRedirectUri?: string;
    oauthScopes?: string[];
  };
  codex: {
    bin: string;
    model?: string;
    sandbox: SandboxMode;
    minSupportedVersion?: string;
    appServerStartupTimeoutMs?: number;
    turnTimeoutMs?: number;
  };
  git?: {
    signingKeyPath?: string;
    githubAuthUrl?: string;
  };
  repos: RepoMapping[];
  policies: PolicyRule[];
}

export interface RepoMapping {
  linearTeams: string[];
  github: string;
  localPath: string;
  defaultBase: string;
  testCommands?: string[];
}

export interface PolicyRule {
  name: string;
  labels?: string[];
  paths?: string[];
  repos?: string[];
  teams?: string[];
  priorities?: number[];
  decision: PolicyDecision;
  sandbox?: SandboxMode;
}

export interface LinearIssueContext {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  teamId?: string;
  teamKey?: string;
  labels: string[];
  priority?: number | { value?: number; name?: string };
  url?: string;
  project?: LinearNamedContext;
  initiative?: LinearNamedContext;
  cycle?: LinearNamedContext;
  milestone?: LinearNamedContext;
  parent?: LinearNamedContext;
  relatedIssues?: LinearNamedContext[];
  customerRequests?: LinearCustomerRequestContext[];
  documents?: LinearNamedContext[];
}

export interface LinearNamedContext {
  id?: string;
  key?: string;
  identifier?: string;
  name?: string;
  title?: string;
  description?: string;
  url?: string;
}

export interface LinearCustomerRequestContext {
  id?: string;
  title?: string;
  body?: string;
  url?: string;
  customer?: LinearNamedContext;
}

export interface LinearAgentSessionEvent {
  type?: string;
  action?: string;
  organizationId?: string;
  oauthClientId?: string;
  appUserId?: string;
  canAccessAllPublicTeams?: boolean;
  addedTeamIds?: string[];
  removedTeamIds?: string[];
  webhookTimestamp?: number;
  webhookId?: string;
  notification?: unknown;
  agentSession?: {
    id: string;
    issue?: LinearIssueContext;
    comment?: LinearCommentContext;
    previousComments?: LinearCommentContext[];
    guidance?: LinearGuidanceContext[];
    promptContext?: string;
    prompt?: string;
  };
  agentActivity?: {
    id?: string;
    body?: string;
    signal?: string;
    signalMetadata?: unknown;
    content?: {
      type?: string;
      body?: string;
      signal?: string;
      signalMetadata?: unknown;
    };
  };
  issue?: LinearIssueContext;
  comment?: LinearCommentContext;
  previousComments?: LinearCommentContext[];
  guidance?: LinearGuidanceContext[];
  promptContext?: string;
  prompt?: string;
}

export interface LinearCommentContext {
  id?: string;
  body?: string;
  url?: string;
  createdAt?: string;
  user?: {
    id?: string;
    name?: string;
    url?: string;
  };
}

export interface LinearGuidanceContext {
  id?: string;
  body?: string;
  origin?: string;
  teamName?: string;
}

export interface RoutedJob {
  id: string;
  sessionId: string;
  prompt: string;
  issue: LinearIssueContext;
  repo: RepoMapping;
  policy: AppliedPolicy;
}

export interface AppliedPolicy {
  ruleName: string;
  decision: PolicyDecision;
  sandbox: SandboxMode;
}

export interface CodexNotification {
  method?: string;
  params?: Record<string, unknown>;
}

export type JobStatus = "queued" | "running" | "waiting_approval" | "denied" | "completed" | "failed" | "canceled";

export interface JobRecord {
  id: string;
  sessionId: string;
  status: JobStatus;
  repo: string;
  prompt?: string;
  branchName?: string;
  worktreePath?: string;
  issueIdentifier?: string;
  issueTitle?: string;
  policyRule: string;
  policyDecision: PolicyDecision;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  canceledAt?: string;
  lastMessage: string;
  retryEligible: boolean;
  retryCount: number;
  failureReason?: string;
}

export interface DaemonState {
  startedAt: string;
  queue?: {
    accepting: boolean;
    concurrency: number;
    running: number;
    queued: number;
  };
  jobs: JobRecord[];
  events: DaemonEvent[];
}

export interface DaemonEvent {
  id: string;
  jobId?: string;
  source: string;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
}
