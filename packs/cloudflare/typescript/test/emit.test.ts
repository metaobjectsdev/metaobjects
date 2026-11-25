// The generators' output for each fixture, pinned as golden files, and every script checked
// by bash and, where installed, shellcheck.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { emit, loadFixture } from "./model.js";

const GOLDEN = join(import.meta.dir, "golden");
/** `UPDATE_GOLDEN=1 bun test` rewrites the golden files from the generators. */
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";
const SCENARIOS = ["cloudflare-worker-environments", "cloudflare-worker-cron-ratelimits", "cloudflare-pages-site"];
const HAS_SHELLCHECK = spawnSync("shellcheck", ["--version"]).status === 0;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe.each(SCENARIOS)("%s", (scenario) => {
  test("the generators write the golden files, and only those", async () => {
    const files = await emit(await loadFixture(scenario));
    const golden = join(GOLDEN, scenario);
    if (UPDATE) {
      rmSync(golden, { recursive: true, force: true });
      for (const [path, content] of files) {
        mkdirSync(dirname(join(golden, path)), { recursive: true });
        writeFileSync(join(golden, path), content);
      }
    }
    expect(existsSync(golden)).toBe(true);
    const expected = new Map(walk(golden).map((p) => [relative(golden, p), readFileSync(p, "utf8")]));
    expect([...files.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [path, content] of files) expect(content).toBe(expected.get(path)!);
  });

  test("every script parses, and passes shellcheck where it is installed", async () => {
    const files = await emit(await loadFixture(scenario));
    const dir = mkdtempSync(join(process.env.DEV_SCRATCH ?? tmpdir(), "pack-cloudflare-sh-"));
    try {
      for (const [path, content] of files) {
        if (!path.endsWith(".sh")) continue;
        const file = join(dir, path.replace(/\//g, "_"));
        writeFileSync(file, content);
        const parse = spawnSync("bash", ["-n", file], { encoding: "utf8" });
        expect({ path, stderr: parse.stderr }).toEqual({ path, stderr: "" });
        if (HAS_SHELLCHECK) {
          const check = spawnSync("shellcheck", ["-s", "bash", file], { encoding: "utf8" });
          expect({ path, findings: check.stdout }).toEqual({ path, findings: "" });
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
