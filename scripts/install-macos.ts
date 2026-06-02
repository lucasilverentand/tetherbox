#!/usr/bin/env bun

import { installMacos, parseInstallArgs } from "./service-install";

await installMacos(parseInstallArgs(process.argv.slice(2), { label: "dev.tetherbox" }));
