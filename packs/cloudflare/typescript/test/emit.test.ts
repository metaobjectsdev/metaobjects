// The generators' output for each fixture, pinned as golden files, and every script checked
// by bash and, where installed, shellcheck.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { editFixture, emit, loadFixture, loadModels } from "./model.js";

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

test("a build-time value with shell syntax in it is exported as written, and only when the variable is unset", async () => {
  const sources = editFixture("cloudflare-pages-site", (r) => {
    const d = (r["metadata.root"].children.find((c) => c["deployment.pages"]?.["name"] === "siteProduction") as Record<string, Record<string, unknown>>)["deployment.pages"]!;
    ((d["children"] ??= []) as unknown[]).push({ "value.literal": { name: "url", "@setting": "Site.url", "@literal": `{"a":"$x}'"}` } });
  });
  const deploy = (await emit(await loadModels(sources))).get("deploy/cloudflare/deploy.sh")!;
  const line = deploy.split("\n").find((l) => l.includes("export SITE_URL="))!.trim();
  const run = (env: Record<string, string>) => spawnSync("bash", ["-c", `${line}; printf %s "$SITE_URL"`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } }).stdout;
  expect(run({})).toBe(`{"a":"$x}'"}`);
  expect(run({ SITE_URL: "custom" })).toBe("custom");
});

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
