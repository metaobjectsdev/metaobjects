import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCollection } from "../src/collection.js";
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

  test("scope compiles into a predicate the caller passes straight through", async () => {
    write("model/meta.a.json", "{}");
    config("apps/ui", { sources: [{ path: "../../model" }], scope: { include: ["acme::**"] } });
    const c = await resolveCollection(join(root, "apps/ui"));
    expect(c.inScope("acme::Order")).toBe(true);
    expect(c.inScope("other::Order")).toBe(false);
  });

  test("an undeclared scope admits everything — the predicate is always defined", async () => {
    write("metaobjects/meta.a.json", "{}");
    config(".", {});
    expect((await resolveCollection(root)).inScope("anything::at::All")).toBe(true);
  });

  test("migrateScope is undefined when not declared", async () => {
    write("metaobjects/meta.a.json", "{}");
    config(".", {});
    expect((await resolveCollection(root)).inMigrateScope).toBeUndefined();
  });

  test("migrateScope compiles when declared", async () => {
    write("metaobjects/meta.a.json", "{}");
    config(".", { migrate: { scope: ["acme::platform::**"] } });
    const c = await resolveCollection(root);
    expect(c.inMigrateScope!("acme::platform::Job")).toBe(true);
    // `**` spans any number of segments — `matchesScope` decides, here as
    // everywhere: there is exactly one implementation of the pattern grammar.
    expect(c.inMigrateScope!("acme::platform::billing::Invoice")).toBe(true);
    expect(c.inMigrateScope!("arena::Match")).toBe(false);
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

  test("a bare metaobjects/ is NOT a project boundary — the ancestor config governs", async () => {
    // A project boundary is a `.metaobjects/config.json`, nothing else. A
    // subdirectory holding only a `metaobjects/` directory declares no project,
    // so the nearest ancestor config governs it — including its `sources`, which
    // may point nowhere near either directory. The alternative (treating a bare
    // directory as a second stop marker) puts a second definition of "where
    // metadata lives" back into the walk, which is exactly what
    // `resolveCollection` exists to be the only one of. A subdirectory that
    // should own its metadata declares a config; `meta init` writes one.
    config(".", {});
    write("metaobjects/meta.root.json", "{}");
    write("apps/ui/metaobjects/meta.ui.json", "{}");
    const c = await resolveCollection(join(root, "apps/ui"));
    expect(c.configDir).toBe(root);
    expect(c.files.map((f) => f.replace(root + "/", ""))).toEqual([
      "metaobjects/meta.root.json",
    ]);
  });

  test("a nearer config wins over an ancestor's", async () => {
    // Nearest-ancestor, first-match-wins: a config beside the start dir governs,
    // and a `metaobjects/` sitting in an ancestor changes nothing.
    write("metaobjects/meta.root.json", "{}");
    write("model/meta.a.json", "{}");
    config("apps/ui", { sources: [{ path: "../../model" }] });
    const c = await resolveCollection(join(root, "apps/ui/src"));
    expect(c.configDir).toBe(join(root, "apps/ui"));
    expect(c.files.map((f) => f.replace(root + "/", ""))).toEqual(["model/meta.a.json"]);
  });
});
