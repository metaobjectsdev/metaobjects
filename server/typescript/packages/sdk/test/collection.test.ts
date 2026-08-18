import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCollection } from "../src/collection.js";
import { matchesScope } from "../src/scope.js";
import { rejectedCode } from "./support/error-code.js";

let root: string;
const write = (rel: string, body: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body, "utf8");
};
const config = (dir: string, cfg: object) =>
  write(join(dir, ".metaobjects/config.json"), JSON.stringify({ schema_version: 1, ...cfg }));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "metaobjects-collection-")); mkdirSync(join(root, ".git")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("resolveCollection", () => {
  test("BACK-COMPAT: no sources declared falls back to metaobjects/", async () => {
    write("metaobjects/meta.a.json", "{}");
    config(".", {});
    const c = await resolveCollection(root);
    expect(c.files.map((f) => f.replace(root + "/", ""))).toEqual(["metaobjects/meta.a.json"]);
  });

  test("BACK-COMPAT: no config at all still finds metaobjects/ in the start dir", async () => {
    write("metaobjects/meta.a.json", "{}");
    const c = await resolveCollection(root);
    expect(c.files).toHaveLength(1);
  });

  test("a consumer reaches a tree elsewhere in the repo", async () => {
    write("model/meta.a.json", "{}");
    config("apps/ui", { sources: [{ path: "../../model" }] });
    const c = await resolveCollection(join(root, "apps/ui"));
    expect(c.configDir).toBe(join(root, "apps/ui"));
    expect(c.files.map((f) => f.replace(root + "/", ""))).toEqual(["model/meta.a.json"]);
  });

  test("scope compiles and is applied by matchesScope", async () => {
    write("model/meta.a.json", "{}");
    config("apps/ui", { sources: [{ path: "../../model" }], scope: { include: ["acme::**"] } });
    const c = await resolveCollection(join(root, "apps/ui"));
    expect(matchesScope("acme::Order", c.scope)).toBe(true);
    expect(matchesScope("other::Order", c.scope)).toBe(false);
  });

  test("migrateScope is undefined when not declared", async () => {
    write("metaobjects/meta.a.json", "{}");
    config(".", {});
    expect((await resolveCollection(root)).migrateScope).toBeUndefined();
  });

  test("migrateScope compiles when declared", async () => {
    write("metaobjects/meta.a.json", "{}");
    config(".", { migrate: { scope: ["acme::platform::**"] } });
    const c = await resolveCollection(root);
    expect(matchesScope("acme::platform::Job", c.migrateScope!)).toBe(true);
    expect(matchesScope("arena::Match", c.migrateScope!)).toBe(false);
  });

  test("an explicit dir overrides discovery", async () => {
    write("model/meta.a.json", "{}");
    config("apps/ui", { sources: [{ path: "../../model" }] });
    config("apps/api", { sources: [{ path: "../../model" }] });
    const c = await resolveCollection(join(root, "apps/ui"), { explicitDir: join(root, "apps/api") });
    expect(c.configDir).toBe(join(root, "apps/api"));
  });

  test("nothing discoverable and no default dir is ERR_COLLECTION_NOT_FOUND", async () => {
    mkdirSync(join(root, "apps/ui"), { recursive: true });
    expect(await rejectedCode(resolveCollection(join(root, "apps/ui")))).toBe(
      "ERR_COLLECTION_NOT_FOUND",
    );
  });

  test("a malformed config.json rejects rather than silently falling back to metaobjects/", async () => {
    write("metaobjects/meta.a.json", "{}");
    // Truncated JSON — config.json EXISTS but cannot be parsed. Must surface
    // as a real load failure, never a silent DEFAULT_SOURCES fallback: a
    // typo'd config that quietly generates from a possibly-stale
    // `metaobjects/` with no diagnostic is worse than the status quo this
    // design set out to fix.
    write(".metaobjects/config.json", '{ "schema_version": 1, ');
    await expect(resolveCollection(root)).rejects.toThrow(SyntaxError);
  });

  test("a .metaobjects/ directory with no config.json still falls back to metaobjects/", async () => {
    write("metaobjects/meta.a.json", "{}");
    mkdirSync(join(root, ".metaobjects"), { recursive: true }); // dir exists, file does not
    const c = await resolveCollection(root);
    expect(c.files.map((f) => f.replace(root + "/", ""))).toEqual(["metaobjects/meta.a.json"]);
  });

  test("BACK-COMPAT: a LOCAL metaobjects/ stops the walk, even under an ancestor config", async () => {
    // The pre-branch layout: a nested project holding its own `metaobjects/` and
    // no config of its own read ITS OWN metadata. Walking past it to an ancestor
    // config silently loads the ancestor's model AND writes generated output to
    // the ancestor's outDir — a silent regression on a layout that worked.
    config(".", {});
    write("metaobjects/meta.root.json", "{}");
    write("apps/ui/metaobjects/meta.ui.json", "{}");
    const c = await resolveCollection(join(root, "apps/ui"));
    expect(c.configDir).toBe(join(root, "apps/ui"));
    expect(c.files.map((f) => f.replace(root + "/", ""))).toEqual([
      "apps/ui/metaobjects/meta.ui.json",
    ]);
  });

  test("a nearer config still wins over a further-down metaobjects/ in an ancestor", async () => {
    // The stop condition is per-DIRECTORY, first-match-wins: the nearest ancestor
    // holding EITHER marker stops the walk, so a config beside the start dir is
    // not skipped just because an ancestor also has a `metaobjects/`.
    write("metaobjects/meta.root.json", "{}");
    write("model/meta.a.json", "{}");
    config("apps/ui", { sources: [{ path: "../../model" }] });
    const c = await resolveCollection(join(root, "apps/ui/src"));
    expect(c.configDir).toBe(join(root, "apps/ui"));
    expect(c.files.map((f) => f.replace(root + "/", ""))).toEqual(["model/meta.a.json"]);
  });
});
