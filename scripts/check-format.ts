import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src", "test", "scripts"];
const problems: string[] = [];

for (const root of roots) {
  await checkDir(root);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

async function checkDir(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await checkDir(path);
      continue;
    }

    if (!path.endsWith(".ts")) {
      continue;
    }

    const content = await readFile(path, "utf8");
    if (!content.endsWith("\n")) {
      problems.push(`${path}: missing trailing newline`);
    }
    if (content.includes("\t")) {
      problems.push(`${path}: contains tab character`);
    }
  }
}
