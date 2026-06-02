import { spawn } from "node:child_process";
import { codexProtocolMetadata } from "../generated/codex-app-server/metadata";

export interface CodexVersionCheck {
  installed: string;
  minimum: string;
}

export async function assertSupportedCodexCli(
  codexBin: string,
  minimum = codexProtocolMetadata.minSupportedCodexCliVersion,
): Promise<CodexVersionCheck> {
  const output = await command(codexBin, ["--version"]);
  const installed = parseCodexCliVersion(output);

  if (compareVersions(installed, minimum) < 0) {
    throw new Error(`Codex CLI ${installed} is unsupported; install codex-cli ${minimum} or newer.`);
  }

  return { installed, minimum };
}

export function parseCodexCliVersion(output: string): string {
  const match = output.match(/\bcodex-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  if (!match) {
    throw new Error(`Unable to parse Codex CLI version from: ${output.trim() || "<empty>"}`);
  }
  return match[1]!;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = numericParts(left);
  const rightParts = numericParts(right);

  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index]! - rightParts[index]!;
    if (delta !== 0) {
      return Math.sign(delta);
    }
  }

  return 0;
}

async function command(bin: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${bin} ${args.join(" ")} failed: ${stderr.trim()}`));
      }
    });
  });
}

function numericParts(version: string): [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
