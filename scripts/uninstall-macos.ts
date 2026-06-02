#!/usr/bin/env bun

import { parseInstallArgs, uninstallMacos } from "./service-install";

const options = parseInstallArgs(process.argv.slice(2), { label: "dev.tetherbox" });
await uninstallMacos(options.label, options.dryRun);
