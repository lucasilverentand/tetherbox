#!/usr/bin/env bun

import { serve } from "./server";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command !== "serve") {
    console.error("Usage: local-linear-codex-bridge serve --config <path>");
    process.exit(1);
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
