import { readFile } from "node:fs/promises";
import type { BridgeConfig } from "./types";

export async function loadConfig(path: string): Promise<BridgeConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<BridgeConfig>;

  if (!parsed.server?.host || !parsed.server.port) {
    throw new Error("Config must include server.host and server.port");
  }

  if (!parsed.linear?.webhookSecretEnv) {
    throw new Error("Config must include linear.webhookSecretEnv");
  }

  if (!parsed.codex?.bin || !parsed.codex.sandbox) {
    throw new Error("Config must include codex.bin and codex.sandbox");
  }

  if (!Array.isArray(parsed.repos) || parsed.repos.length === 0) {
    throw new Error("Config must include at least one repo mapping");
  }

  return {
    ...parsed,
    state: parsed.state ?? { path: "state/daemon.sqlite" },
    linear: {
      ...parsed.linear,
      webhookMaxAgeMs: parsed.linear.webhookMaxAgeMs ?? 60_000,
      apiTimeoutMs: parsed.linear.apiTimeoutMs ?? 8_000,
      agentActivityHistoryLimit: parsed.linear.agentActivityHistoryLimit ?? 100,
      agentSessionPollIntervalMs: parsed.linear.agentSessionPollIntervalMs ?? 0,
      agentSessionPollFirst: parsed.linear.agentSessionPollFirst ?? 20,
      reviewStateName: parsed.linear.reviewStateName ?? "In Review",
    },
    queue: {
      concurrency: parsed.queue?.concurrency ?? 1,
      shutdownGraceMs: parsed.queue?.shutdownGraceMs ?? 30_000,
      approvalTimeoutMs: parsed.queue?.approvalTimeoutMs ?? 24 * 60 * 60 * 1000,
    },
    git: {
      signingKeyPath: parsed.git?.signingKeyPath ?? "~/.ssh/codex_signing_key",
      githubAuthUrl: parsed.git?.githubAuthUrl,
      authorName: parsed.git?.authorName ?? "Tetherbox",
      authorEmail: parsed.git?.authorEmail ?? "tetherbox@users.noreply.github.com",
      coAuthorName: parsed.git?.coAuthorName ?? "Codex",
      coAuthorEmail: parsed.git?.coAuthorEmail ?? "codex@openai.com",
    },
    policies: parsed.policies ?? [],
  } as BridgeConfig;
}

export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
