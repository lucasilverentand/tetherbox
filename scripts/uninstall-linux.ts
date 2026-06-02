#!/usr/bin/env bun

import { parseInstallArgs, uninstallLinux } from "./service-install";

const options = parseInstallArgs(process.argv.slice(2), { label: "tetherbox" });
await uninstallLinux(options.label, options.dryRun);
