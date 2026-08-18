import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSources, DEFAULT_SOURCES } from "../src/sources.js";
import { rejectedCode } from "./support/error-code.js";

let root: string;
const write = (rel: string, body = "{}") => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
  return full;
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "metaobjects-sources-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

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

  test("the spec attributed to an overlapping file is order-independent, not just the file list", async () => {
    write("model/meta.a.json");
    const forward = await resolveSources(root, [{ path: "model" }, { path: "model/meta.a.json" }]);
    const reverse = await resolveSources(root, [{ path: "model/meta.a.json" }, { path: "model" }]);
    // Deep-equal on the FULL ResolvedSource[] — .spec included, not just .file.
    // A first-spec-wins tie-break would pass the two `de-duplicates` /
    // `canonically sorted` tests above yet fail here, because which spec is
    // attributed would flip between forward and reverse.
    expect(forward).toEqual(reverse);
    // Pin the actual deterministic winner: content-only comparison picks
    // whichever spec's JSON.stringify sorts first, regardless of which was
    // declared (or processed) first.
    expect(forward).toHaveLength(1);
    expect(forward[0]?.spec).toEqual({ path: "model" });
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

  test("an unsupported kind is reported regardless of declaration order relative to an unresolvable path", async () => {
    // Kind validation used to be interleaved with per-spec filesystem I/O in
    // one loop, so an unsupported-kind spec placed AFTER an unresolvable
    // path spec never got reached — the path spec's ERR_SOURCE_UNRESOLVED
    // fired first, and the reported code silently depended on which spec
    // was declared first. Both orderings must report the SAME code.
    const unsupportedFirst: Parameters<typeof resolveSources>[1] = [
      { resource: "acme/model" },
      { path: "missing" },
    ];
    const unresolvedFirst: Parameters<typeof resolveSources>[1] = [
      { path: "missing" },
      { resource: "acme/model" },
    ];
    expect(await rejectedCode(resolveSources(root, unsupportedFirst))).toBe(
      "ERR_SOURCE_KIND_UNSUPPORTED",
    );
    expect(await rejectedCode(resolveSources(root, unresolvedFirst))).toBe(
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

  test("a dangling symlink inside a source directory is skipped, not a raw ENOENT crash", async () => {
    // DirectorySource in @metaobjectsdev/metadata catches and skips exactly
    // this case (directory-source.ts). Before the fix, the bare `stat()` in
    // collectDir had no try/catch, so a dangling symlink crashed
    // resolveSources with a raw Node ENOENT carrying no ERR_ code — on a
    // tree the loader itself reads fine.
    write("model/meta.a.json");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(root, "model/does-not-exist"), join(root, "model/dangling.json"));
    const out = await resolveSources(root, [{ path: "model" }]);
    expect(out.map((r) => r.file.replace(root + "/", ""))).toEqual(["model/meta.a.json"]);
  });

  test("DEFAULT_SOURCES is the metaobjects/ directory", () => {
    expect(DEFAULT_SOURCES).toEqual([{ path: "metaobjects" }]);
  });
});
