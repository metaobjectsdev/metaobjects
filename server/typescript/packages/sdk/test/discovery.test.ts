import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfigDir } from "../src/discovery.js";

let root: string;
const mk = (rel: string) => mkdirSync(join(root, rel), { recursive: true });
const cfg = (rel: string) => {
  mk(join(rel, ".metaobjects"));
  writeFileSync(join(root, rel, ".metaobjects/config.json"), '{"schema_version":1}', "utf8");
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "metaobjects-discovery-")); mk(".git"); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("findConfigDir", () => {
  test("finds a config in the start directory", async () => {
    cfg("apps/ui"); mk("apps/ui/src");
    expect(await findConfigDir(join(root, "apps/ui"))).toBe(join(root, "apps/ui"));
  });
  test("walks up to the nearest ancestor config", async () => {
    cfg("apps/ui"); mk("apps/ui/src/deep");
    expect(await findConfigDir(join(root, "apps/ui/src/deep"))).toBe(join(root, "apps/ui"));
  });
  test("nearest wins over a further ancestor", async () => {
    cfg("."); cfg("apps/ui"); mk("apps/ui/src");
    expect(await findConfigDir(join(root, "apps/ui/src"))).toBe(join(root, "apps/ui"));
  });
  test("stops at the repository boundary — never adopts a parent checkout's config", async () => {
    // A config ABOVE the .git boundary must not be found.
    const outer = mkdtempSync(join(tmpdir(), "metaobjects-outer-"));
    try {
      mkdirSync(join(outer, "inner/.git"), { recursive: true });
      mkdirSync(join(outer, ".metaobjects"), { recursive: true });
      writeFileSync(join(outer, ".metaobjects/config.json"), '{"schema_version":1}', "utf8");
      mkdirSync(join(outer, "inner/src"), { recursive: true });
      expect(await findConfigDir(join(outer, "inner/src"))).toBeUndefined();
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
  test("a repo-root config IS found from a subdirectory", async () => {
    cfg("."); mk("apps/ui");
    expect(await findConfigDir(join(root, "apps/ui"))).toBe(root);
  });
  test("returns undefined when nothing is found", async () => {
    mk("apps/ui");
    expect(await findConfigDir(join(root, "apps/ui"))).toBeUndefined();
  });
});
