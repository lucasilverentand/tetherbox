#!/usr/bin/env bun

import { installLinux, parseInstallArgs } from "./service-install";

await installLinux(parseInstallArgs(process.argv.slice(2), { label: "tetherbox" }));
