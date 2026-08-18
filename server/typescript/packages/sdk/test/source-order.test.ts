// server/typescript/packages/sdk/test/source-order.test.ts
//
// The load-ORDER gate for resolved sources.
//
// Order independence (`order-independence.test.ts`) proves the resolved SET
// is a pure function of the declared spec set. It says nothing about the
// order that set is handed to the loader in — and that order IS observable in
// generated output: `codegen-ts`'s barrel emits exports straight from
// `root.objects()` order, and the same order flows into the shared `enums.ts`,
// `meta docs` page ordering, and `meta export`'s `canonicalSerialize` sibling
// order.
//
// The pre-source-resolution toolchain read every file through
// `listMetadataFiles` (memory.ts), which visits FILES at a level before
// descending into that level's subdirectories. A flat lexicographic sort of
// absolute paths disagrees with it the moment a subdirectory name sorts before
// a sibling file — `metaobjects/common/…` before `metaobjects/meta.users.json`
// is exactly that shape, and it is the shape this fixture builds. Every
// `metaobjects/` tree committed in this repository is FLAT, so nothing else
// here can observe the property.
//
// The structural half of the fix is that there is now ONE walker:
// `resolveSources` calls `listMetadataFiles` rather than keeping a second
// recursive walk of its own. These tests pin the resulting order directly, so
// re-splitting the walkers (or "simplifying" either one back to a flat sort)
// goes red rather than silently reordering everyone's generated code.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_METADATA_DIR, listMetadataFiles, loadMemory } from "../src/memory.js";
import { resolveSources, type SourceSpec } from "../src/sources.js";
import { resolveCollection } from "../src/collection.js";

let root: string;

const write = (rel: string, body: object): void => {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(body), "utf8");
};

const entity = (pkg: string, name: string): object => ({
  "metadata.root": {
    package: pkg,
    children: [
      { "object.entity": { name, children: [{ "field.string": { name: "id" } }] } },
    ],
  },
});

const relative = (files: readonly string[]): string[] =>
  files.map((f) => f.slice(root.length + 1));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "metaobjects-source-order-"));
  // `common` sorts BEFORE `meta.users.json` as a plain string, so a flat sort
  // of absolute paths puts the SUBDIRECTORY first. The walker production used
  // before this branch puts the file first.
  write(join(DEFAULT_METADATA_DIR, "common", "meta.base.json"), entity("acme", "BaseThing"));
  write(join(DEFAULT_METADATA_DIR, "meta.users.json"), entity("acme", "User"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolved source order — nested directories", () => {
  test("files at a level come before that level's subdirectories", async () => {
    const out = await resolveSources(root, [{ path: DEFAULT_METADATA_DIR }]);
    expect(relative(out.map((r) => r.file))).toEqual([
      "metaobjects/meta.users.json",
      "metaobjects/common/meta.base.json",
    ]);
  });

  test("the fixture actually discriminates — a flat sort would order it the other way", async () => {
    // Without this the assertion above could pass on a flat-sorting resolver
    // and nobody would notice the gate had stopped testing anything.
    const out = await resolveSources(root, [{ path: DEFAULT_METADATA_DIR }]);
    const files = out.map((r) => r.file);
    expect([...files].sort()).not.toEqual(files);
  });

  test("resolveSources agrees with listMetadataFiles, the walker production used before this branch", async () => {
    const out = await resolveSources(root, [{ path: DEFAULT_METADATA_DIR }]);
    const legacy = await listMetadataFiles(join(root, DEFAULT_METADATA_DIR));
    expect(out.map((r) => r.file)).toEqual(legacy);
  });

  test("resolveCollection's default path resolves that same order", async () => {
    const collection = await resolveCollection(root);
    const legacy = await listMetadataFiles(join(root, DEFAULT_METADATA_DIR));
    expect([...collection.files]).toEqual(legacy);
  });

  test("the loaded tree's sibling order follows it — the observable half", async () => {
    // The reason any of this matters: declaration order survives into
    // `root.children()`, which is what the barrel generator emits from.
    const collection = await resolveCollection(root);
    const loaded = await loadMemory(collection.configDir, { files: collection.files });
    expect(loaded.children().map((c) => c.name)).toEqual(["User", "BaseThing"]);
  });
});

describe("resolved source order — across several specs", () => {
  beforeEach(() => {
    write(join("extra", "nested", "meta.deep.json"), entity("acme", "Deep"));
    write(join("extra", "meta.top.json"), entity("acme", "Top"));
  });

  test("each spec contributes its own per-level order, and specs are ordered by content", async () => {
    // "extra" sorts before "metaobjects", so its files lead; within each spec
    // the per-level rule applies.
    const out = await resolveSources(root, [{ path: DEFAULT_METADATA_DIR }, { path: "extra" }]);
    expect(relative(out.map((r) => r.file))).toEqual([
      "extra/meta.top.json",
      "extra/nested/meta.deep.json",
      "metaobjects/meta.users.json",
      "metaobjects/common/meta.base.json",
    ]);
  });

  test("permuting the specs cannot change the order (set purity survives the per-level walk)", async () => {
    const specs: SourceSpec[] = [{ path: DEFAULT_METADATA_DIR }, { path: "extra" }];
    const forward = await resolveSources(root, specs);
    const reverse = await resolveSources(root, [...specs].reverse());
    expect(forward).toEqual(reverse);
  });
});
