#!/usr/bin/env bun

import { serve } from "./server";
import { runTui } from "./tui";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command !== "serve" && command !== "daemon" && command !== "tui") {
    console.error("Usage: tetherbox <daemon|serve|tui> [--config <path>] [--url <url>]");
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

  await serve(configPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
