import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");

// Resolve a relative import specifier from `fromFile` to an absolute .ts path.
function resolveLocal(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined; // bare specifier — not a local file
  const base = resolve(dirname(fromFile), spec);
  // imports are written with a .js extension; the source file is .ts
  return base.replace(/\.js$/, ".ts");
}

async function collectImports(file: string, seen: Set<string>): Promise<void> {
  if (seen.has(file)) return;
  seen.add(file);
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch {
    return; // unresolved path — ignore (a missing file would fail the build elsewhere)
  }
  const importRe = /(?:import|export)[^"']*?from\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(importRe)) {
    const spec = m[1]!;
    const local = resolveLocal(file, spec);
    if (local !== undefined) {
      await collectImports(local, seen);
    }
  }
}

describe("browser safety — the root entry imports nothing Node-only", () => {
  it("no file reachable from src/index.ts imports node:fs or yaml", async () => {
    const seen = new Set<string>();
    await collectImports(resolve(SRC, "index.ts"), seen);

    const offenders: string[] = [];
    for (const file of seen) {
      const text = await readFile(file, "utf-8");
      if (/from\s*["']node:fs(\/promises)?["']/.test(text) || /["']node:fs(\/promises)?["']/.test(text)) {
        offenders.push(`${file} imports node:fs`);
      }
      if (/from\s*["']yaml["']/.test(text)) {
        offenders.push(`${file} imports yaml`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
