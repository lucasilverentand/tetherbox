import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const codexBin = process.env.CODEX_BIN ?? "codex";
const outDir = process.argv[2] ?? "generated/codex-app-server";
const typesDir = join(outDir, "types");
const schemaDir = join(outDir, "schema");

const versionOutput = await command(codexBin, ["--version"]);
const codexCliVersion = parseCodexCliVersion(versionOutput);

await mkdir(outDir, { recursive: true });
await command(codexBin, ["app-server", "generate-ts", "--out", typesDir]);
await command(codexBin, ["app-server", "generate-json-schema", "--out", schemaDir]);

const generatedAt = new Date().toISOString();
const metadata = {
  codexCliVersion,
  generatedAt,
  minSupportedCodexCliVersion: codexCliVersion,
};

await writeFile(join(outDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
await writeFile(
  join(outDir, "metadata.ts"),
  [
    "// GENERATED CODE! DO NOT MODIFY BY HAND!",
    "",
    `export const codexProtocolMetadata = ${JSON.stringify(metadata, null, 2)} as const;`,
    "",
  ].join("\n"),
);

console.log(`Generated Codex App Server protocol bindings from codex-cli ${codexCliVersion}`);

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

function parseCodexCliVersion(output: string): string {
  const match = output.match(/\bcodex-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  if (!match) {
    throw new Error(`Unable to parse Codex CLI version from: ${output.trim() || "<empty>"}`);
  }
  return match[1]!;
}
