import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface InstallOptions {
  repoPath: string;
  configPath: string;
  envFile?: string;
  label: string;
  dryRun: boolean;
}

export interface MacosInstallPlan {
  plistPath: string;
  plist: string;
  commands: string[][];
}

export interface LinuxInstallPlan {
  servicePath: string;
  service: string;
  commands: string[][];
}

export function parseInstallArgs(argv: string[], defaults: Partial<InstallOptions> = {}): InstallOptions {
  const option = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };

  return {
    repoPath: resolve(expandHome(option("--repo") ?? defaults.repoPath ?? process.cwd())),
    configPath: resolve(expandHome(option("--config") ?? defaults.configPath ?? "~/.config/tetherbox/config.json")),
    envFile: option("--env-file")
      ? resolve(expandHome(option("--env-file") as string))
      : defaults.envFile
        ? resolve(expandHome(defaults.envFile))
        : undefined,
    label: option("--label") ?? defaults.label ?? "dev.tetherbox",
    dryRun: argv.includes("--dry-run") || defaults.dryRun === true,
  };
}

export function macosInstallPlan(options: InstallOptions): MacosInstallPlan {
  const plistPath = resolve(expandHome(`~/Library/LaunchAgents/${options.label}.plist`));
  return {
    plistPath,
    plist: renderLaunchdPlist(options),
    commands: [
      ["launchctl", "bootout", `gui/${process.getuid?.() ?? ""}`, plistPath],
      ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? ""}`, plistPath],
      ["launchctl", "enable", `gui/${process.getuid?.() ?? ""}/${options.label}`],
      ["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? ""}/${options.label}`],
    ],
  };
}

export function macosUninstallPlan(label = "dev.tetherbox"): { plistPath: string; commands: string[][] } {
  const plistPath = resolve(expandHome(`~/Library/LaunchAgents/${label}.plist`));
  return {
    plistPath,
    commands: [["launchctl", "bootout", `gui/${process.getuid?.() ?? ""}`, plistPath]],
  };
}

export function linuxInstallPlan(options: InstallOptions): LinuxInstallPlan {
  const serviceName = options.label.endsWith(".service") ? options.label : `${options.label}.service`;
  const servicePath = resolve(expandHome(`~/.config/systemd/user/${serviceName}`));
  return {
    servicePath,
    service: renderSystemdService(options),
    commands: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", serviceName],
    ],
  };
}

export function linuxUninstallPlan(label = "tetherbox"): { servicePath: string; serviceName: string; commands: string[][] } {
  const serviceName = label.endsWith(".service") ? label : `${label}.service`;
  return {
    serviceName,
    servicePath: resolve(expandHome(`~/.config/systemd/user/${serviceName}`)),
    commands: [
      ["systemctl", "--user", "disable", "--now", serviceName],
      ["systemctl", "--user", "daemon-reload"],
    ],
  };
}

export async function installMacos(options: InstallOptions): Promise<void> {
  const plan = macosInstallPlan(options);
  await outputFile(plan.plistPath, plan.plist, options.dryRun);
  await runCommands(plan.commands.slice(0, 1), options.dryRun, true);
  await runCommands(plan.commands.slice(1), options.dryRun, false);
}

export async function uninstallMacos(label: string, dryRun: boolean): Promise<void> {
  const plan = macosUninstallPlan(label);
  await runCommands(plan.commands, dryRun, true);
  await removeFile(plan.plistPath, dryRun);
}

export async function installLinux(options: InstallOptions): Promise<void> {
  const plan = linuxInstallPlan(options);
  await outputFile(plan.servicePath, plan.service, options.dryRun);
  await runCommands(plan.commands, options.dryRun, false);
}

export async function uninstallLinux(label: string, dryRun: boolean): Promise<void> {
  const plan = linuxUninstallPlan(label);
  await runCommands(plan.commands, dryRun, true);
  await removeFile(plan.servicePath, dryRun);
}

export function renderLaunchdPlist(options: InstallOptions): string {
  const command = [
    options.envFile ? `. ${shellQuote(options.envFile)};` : undefined,
    "exec",
    "bun",
    "run",
    "src/index.ts",
    "daemon",
    "--config",
    shellQuote(options.configPath),
  ]
    .filter(Boolean)
    .join(" ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(options.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/sh</string>
      <string>-lc</string>
      <string>${escapeXml(command)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(options.repoPath)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(expandHome("~/Library/Logs/tetherbox.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(expandHome("~/Library/Logs/tetherbox.err.log"))}</string>
  </dict>
</plist>
`;
}

export function renderSystemdService(options: InstallOptions): string {
  return `[Unit]
Description=Tetherbox
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${options.repoPath}
${options.envFile ? `EnvironmentFile=-${options.envFile}\n` : ""}ExecStart=/usr/bin/env bun run src/index.ts daemon --config ${options.configPath}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return `${homedir()}${path.slice(1)}`;
  }
  return path;
}

async function outputFile(path: string, content: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`Would write ${path}:`);
    console.log(content);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  console.log(`Wrote ${path}`);
}

async function removeFile(path: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`Would remove ${path}`);
    return;
  }
  await rm(path, { force: true });
  console.log(`Removed ${path}`);
}

async function runCommands(commands: string[][], dryRun: boolean, ignoreFailures: boolean): Promise<void> {
  for (const command of commands) {
    if (dryRun) {
      console.log(`Would run: ${command.map(shellQuote).join(" ")}`);
      continue;
    }
    try {
      await run(command[0] as string, command.slice(1));
    } catch (error) {
      if (!ignoreFailures) {
        throw error;
      }
      console.warn(error instanceof Error ? error.message : String(error));
    }
  }
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const proc = spawn(command, args, { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "unknown"}`));
      }
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
