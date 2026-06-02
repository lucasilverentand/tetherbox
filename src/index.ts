#!/usr/bin/env bun

import { serve } from "./server";
import { loadConfig } from "./config";
import { StateStore } from "./state-store";
import { runTui } from "./tui";
import { garbageCollectWorktrees } from "./worktree-manager";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command !== "serve" && command !== "daemon" && command !== "tui" && command !== "gc-worktrees") {
    console.error("Usage: tetherbox <daemon|serve|tui|gc-worktrees> [--config <path>] [--url <url>]");
    process.exit(1);
  }

  if (command === "tui") {
    await runTui({
      url: getArg("--url") ?? "http://127.0.0.1:8787",
      intervalMs: Number(getArg("--interval-ms") ?? 2000),
    });
    return;
  }

  const configPath = getArg("--config");
  if (!configPath) {
    console.error("Missing --config <path>");
    process.exit(1);
  }

  if (command === "gc-worktrees") {
    const config = await loadConfig(configPath);
    const state = new StateStore(config.state?.path ?? "state/daemon.json");
    await state.load();
    const result = await garbageCollectWorktrees(config, state.snapshot());
    console.log(`Removed ${result.removed.length} worktree(s), skipped ${result.skipped.length}.`);
    return;
  }

  await serve(configPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
