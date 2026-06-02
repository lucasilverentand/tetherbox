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
    queue: {
      concurrency: parsed.queue?.concurrency ?? 1,
      shutdownGraceMs: parsed.queue?.shutdownGraceMs ?? 30_000,
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
