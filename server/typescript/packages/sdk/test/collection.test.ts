import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCollection } from "../src/collection.js";
import { matchesScope } from "../src/scope.js";

let root: string;
const write = (rel: string, body: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body, "utf8");
};
const config = (dir: string, cfg: object) =>
  write(join(dir, ".metaobjects/config.json"), JSON.stringify({ schema_version: 1, ...cfg }));

/** Pull the stable ERR_ code off a caught error, if it carries one. Mirrors
 *  scope.test.ts / sources.test.ts's `errorCode` — property-based, never
 *  message-matching or `instanceof`: a cross-package `instanceof ParseError`
 *  is silently false when two physical copies of `@metaobjectsdev/metadata`
 *  are loaded, so `.code` is the only reliable read. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "ERR_UNKNOWN";
}

/** Await `promise`, expecting it to reject — returns the rejection's stable
 *  code. Mirrors sources.test.ts's `rejectedCode`. */
async function rejectedCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return errorCode(err);
  }
  throw new Error("expected the promise to reject, but it resolved");
}

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
});
