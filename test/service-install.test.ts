import { describe, expect, test } from "bun:test";
import { linuxInstallPlan, macosInstallPlan, parseInstallArgs } from "../scripts/service-install";

describe("service install scripts", () => {
  test("renders a launchd user agent for the current repo and config", () => {
    const plan = macosInstallPlan({
      repoPath: "/tmp/tetherbox",
      configPath: "/Users/luca/.config/tetherbox/config.json",
      envFile: "/Users/luca/.config/tetherbox/tetherbox.env",
      label: "dev.tetherbox",
      dryRun: true,
    });

    expect(plan.plistPath).toContain("Library/LaunchAgents/dev.tetherbox.plist");
    expect(plan.plist).toContain("<string>dev.tetherbox</string>");
    expect(plan.plist).toContain("<string>/tmp/tetherbox</string>");
    expect(plan.plist).toContain(". &apos;/Users/luca/.config/tetherbox/tetherbox.env&apos;");
    expect(plan.commands.some((command) => command.includes("bootstrap"))).toBe(true);
  });

  test("renders a systemd user service with an optional env file", () => {
    const plan = linuxInstallPlan({
      repoPath: "/home/luca/src/tetherbox",
      configPath: "/home/luca/.config/tetherbox/config.json",
      envFile: "/home/luca/.config/tetherbox/tetherbox.env",
      label: "tetherbox",
      dryRun: true,
    });

    expect(plan.servicePath).toContain(".config/systemd/user/tetherbox.service");
    expect(plan.service).toContain("WorkingDirectory=/home/luca/src/tetherbox");
    expect(plan.service).toContain("EnvironmentFile=-/home/luca/.config/tetherbox/tetherbox.env");
    expect(plan.service).toContain("ExecStart=/usr/bin/env bun run src/index.ts daemon --config /home/luca/.config/tetherbox/config.json");
    expect(plan.commands).toContainEqual(["systemctl", "--user", "enable", "--now", "tetherbox.service"]);
  });

  test("parses install arguments with user-owned defaults", () => {
    const options = parseInstallArgs([
      "--repo",
      "/tmp/tetherbox",
      "--config",
      "~/.config/tetherbox/config.json",
      "--label",
      "dev.tetherbox",
      "--dry-run",
    ]);

    expect(options.repoPath).toBe("/tmp/tetherbox");
    expect(options.configPath).toContain(".config/tetherbox/config.json");
    expect(options.label).toBe("dev.tetherbox");
    expect(options.dryRun).toBe(true);
  });
});
