export type PolicyDecision = "allow_auto" | "allow_plan_only" | "require_approval" | "deny";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface BridgeConfig {
  server: {
    host: string;
    port: number;
    publicUrl?: string;
  };
  state?: {
    path: string;
    worktreeRetentionDays?: number;
  };
  queue?: {
    concurrency?: number;
    shutdownGraceMs?: number;
  };
  linear: {
    webhookSecretEnv: string;
    apiKeyEnv?: string;
    repositorySuggestionMinConfidence?: number;
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
  decision: PolicyDecision;
  sandbox?: SandboxMode;
}

export interface LinearIssueContext {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  teamKey?: string;
  labels: string[];
  url?: string;
}

export interface LinearAgentSessionEvent {
  type?: string;
  action?: string;
  organizationId?: string;
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
    content?: {
      type?: string;
      body?: string;
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
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
}
