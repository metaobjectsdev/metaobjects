import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCollectionRoot, resolveConfigDir } from "../src/discovery.js";

let root: string;
const mk = (rel: string) => mkdirSync(join(root, rel), { recursive: true });
const cfg = (rel: string) => {
  mk(join(rel, ".metaobjects"));
  writeFileSync(join(root, rel, ".metaobjects/config.json"), '{"schema_version":1}', "utf8");
};
/** The second stop marker: a `metaobjects/` directory, no config. */
const meta = (rel: string) => mk(join(rel, "metaobjects"));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "metaobjects-discovery-")); mk(".git"); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("discoverCollectionRoot — config marker", () => {
  test("finds a config in the start directory", async () => {
    cfg("apps/ui"); mk("apps/ui/src");
    expect(await discoverCollectionRoot(join(root, "apps/ui"))).toEqual({
      dir: join(root, "apps/ui"), hasConfig: true,
    });
  });
  test("walks up to the nearest ancestor config", async () => {
    cfg("apps/ui"); mk("apps/ui/src/deep");
    expect(await resolveConfigDir(join(root, "apps/ui/src/deep"))).toBe(join(root, "apps/ui"));
  });
  test("nearest wins over a further ancestor", async () => {
    cfg("."); cfg("apps/ui"); mk("apps/ui/src");
    expect(await resolveConfigDir(join(root, "apps/ui/src"))).toBe(join(root, "apps/ui"));
  });
  test("stops at the repository boundary — never adopts a parent checkout's config", async () => {
    // A config ABOVE the .git boundary must not be found.
    const outer = mkdtempSync(join(tmpdir(), "metaobjects-outer-"));
    try {
      mkdirSync(join(outer, "inner/.git"), { recursive: true });
      mkdirSync(join(outer, ".metaobjects"), { recursive: true });
      writeFileSync(join(outer, ".metaobjects/config.json"), '{"schema_version":1}', "utf8");
      mkdirSync(join(outer, "inner/src"), { recursive: true });
      const start = join(outer, "inner/src");
      expect(await discoverCollectionRoot(start)).toEqual({ dir: start, hasConfig: false });
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
  test("a repo-root config IS found from a subdirectory", async () => {
    cfg("."); mk("apps/ui");
    expect(await resolveConfigDir(join(root, "apps/ui"))).toBe(root);
  });
  test("falls back to the start directory when nothing is found", async () => {
    mk("apps/ui");
    const start = join(root, "apps/ui");
    expect(await discoverCollectionRoot(start)).toEqual({ dir: start, hasConfig: false });
  });
});

describe("discoverCollectionRoot — metaobjects/ marker", () => {
  test("a LOCAL metaobjects/ stops the walk, reported as config-less", async () => {
    cfg("."); meta("."); meta("apps/ui"); mk("apps/ui/src");
    expect(await discoverCollectionRoot(join(root, "apps/ui"))).toEqual({
      dir: join(root, "apps/ui"), hasConfig: false,
    });
  });
  test("the walk reaches a metaobjects/ marker from a subdirectory", async () => {
    meta("apps/ui"); mk("apps/ui/src/deep");
    expect(await resolveConfigDir(join(root, "apps/ui/src/deep"))).toBe(join(root, "apps/ui"));
  });
  test("a config in the SAME directory wins — hasConfig is true", async () => {
    cfg("apps/ui"); meta("apps/ui");
    expect(await discoverCollectionRoot(join(root, "apps/ui"))).toEqual({
      dir: join(root, "apps/ui"), hasConfig: true,
    });
  });
  test("a nearer config beats a further ancestor's metaobjects/", async () => {
    meta("."); cfg("apps/ui"); mk("apps/ui/src");
    expect(await discoverCollectionRoot(join(root, "apps/ui/src"))).toEqual({
      dir: join(root, "apps/ui"), hasConfig: true,
    });
  });
  test("a FILE named metaobjects is not a metadata home", async () => {
    cfg("."); mk("apps/ui");
    writeFileSync(join(root, "apps/ui/metaobjects"), "not a directory", "utf8");
    expect(await resolveConfigDir(join(root, "apps/ui"))).toBe(root);
  });
});
