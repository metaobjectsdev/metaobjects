import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSources, DEFAULT_SOURCES } from "../src/sources.js";

let root: string;
const write = (rel: string, body = "{}") => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
  return full;
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "metaobjects-sources-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Pull the stable ERR_ code off a caught error, if it carries one. Mirrors
 *  scope.test.ts's `errorCode` — property-based, never message-matching: a
 *  cross-package `instanceof ParseError` is silently false when two physical
 *  copies of `@metaobjectsdev/metadata` are loaded (a globally-installed or
 *  linked CLI alongside a project-local dependency), so `.code` is the only
 *  reliable read. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "ERR_UNKNOWN";
}

/** Await `promise`, expecting it to reject — returns the rejection's stable
 *  code. The async counterpart of `errorCode` above, needed because
 *  `resolveSources` is async where `compileScope` (scope.test.ts) is not. */
async function rejectedCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return errorCode(err);
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("resolveSources", () => {
  test("resolves a directory recursively, metadata files only", async () => {
    write("model/meta.a.json");
    write("model/nested/meta.b.yaml");
    write("model/notes.txt");
    const out = await resolveSources(root, [{ path: "model" }]);
    expect(out.map((r) => r.file.replace(root + "/", ""))).toEqual([
      "model/meta.a.json",
      "model/nested/meta.b.yaml",
    ]);
  });

  test("resolves a single file", async () => {
    write("model/meta.a.json");
    const out = await resolveSources(root, [{ path: "model/meta.a.json" }]);
    expect(out).toHaveLength(1);
  });

  test("output is canonically sorted regardless of spec order", async () => {
    write("b/meta.b.json");
    write("a/meta.a.json");
    const forward = await resolveSources(root, [{ path: "a" }, { path: "b" }]);
    const reverse = await resolveSources(root, [{ path: "b" }, { path: "a" }]);
    expect(forward.map((r) => r.file)).toEqual(reverse.map((r) => r.file));
  });

  test("de-duplicates a file contributed by two overlapping specs", async () => {
    write("model/meta.a.json");
    const out = await resolveSources(root, [{ path: "model" }, { path: "model/meta.a.json" }]);
    expect(out).toHaveLength(1);
  });

  test("paths resolve against the config dir, not process.cwd()", async () => {
    write("apps/ui/.keep");
    write("model/meta.a.json");
    const out = await resolveSources(join(root, "apps/ui"), [{ path: "../../model" }]);
    expect(out).toHaveLength(1);
  });

  test("an unresolvable path is ERR_SOURCE_UNRESOLVED, never a silent skip", async () => {
    expect(await rejectedCode(resolveSources(root, [{ path: "missing" }]))).toBe(
      "ERR_SOURCE_UNRESOLVED",
    );
  });

  test("resource and package kinds are ERR_SOURCE_KIND_UNSUPPORTED in phase 1", async () => {
    expect(await rejectedCode(resolveSources(root, [{ resource: "acme/model" }]))).toBe(
      "ERR_SOURCE_KIND_UNSUPPORTED",
    );
    expect(await rejectedCode(resolveSources(root, [{ package: "@acme/model" }]))).toBe(
      "ERR_SOURCE_KIND_UNSUPPORTED",
    );
  });

  test("_pending is excluded at any depth", async () => {
    write("model/meta.a.json");
    write("model/_pending/meta.draft.json");
    const out = await resolveSources(root, [{ path: "model" }]);
    expect(out).toHaveLength(1);
  });

  test("a nested symlinked directory is followed", async () => {
    write("real/meta.b.json");
    write("model/meta.a.json");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(root, "real"), join(root, "model/linked"), "dir");
    const out = await resolveSources(root, [{ path: "model" }]);
    expect(out).toHaveLength(2);
  });

  test("DEFAULT_SOURCES is the metaobjects/ directory", () => {
    expect(DEFAULT_SOURCES).toEqual([{ path: "metaobjects" }]);
  });
});
