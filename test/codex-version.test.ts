import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { assertSupportedCodexCli, compareVersions, parseCodexCliVersion } from "../src/codex-version";

describe("Codex CLI version handling", () => {
  test("parses codex-cli version output", () => {
    expect(parseCodexCliVersion("codex-cli 0.135.0\n")).toBe("0.135.0");
    expect(parseCodexCliVersion("WARNING: ignored\ncodex-cli 1.2.3\n")).toBe("1.2.3");
  });

  test("rejects malformed version output", () => {
    expect(() => parseCodexCliVersion("codex 0.135.0")).toThrow("Unable to parse Codex CLI version");
  });

  test("compares semantic versions", () => {
    expect(compareVersions("0.135.0", "0.135.0")).toBe(0);
    expect(compareVersions("0.136.0", "0.135.0")).toBe(1);
    expect(compareVersions("0.134.9", "0.135.0")).toBe(-1);
  });

  test("fails clearly for unsupported installed versions", async () => {
    const bin = await fakeCodex("codex-cli 0.134.0");

    await expect(assertSupportedCodexCli(bin, "0.135.0")).rejects.toThrow(
      "Codex CLI 0.134.0 is unsupported; install codex-cli 0.135.0 or newer.",
    );
  });
});

async function fakeCodex(output: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const bin = join(dir, "codex");
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  await chmod(bin, 0o755);
  return bin;
}
