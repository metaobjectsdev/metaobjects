// server/typescript/packages/sdk/test/order-independence.test.ts
//
// The order-independence gate — the linchpin of the whole design. The
// premise everything else rests on: resolution is a pure function of the
// declared source SET, so the order sources are declared in carries no
// information. That is why the design has no ordered-list semantics, no
// topological sort, no cycle detection, and no diamond-dependency problem.
//
// The premise splits into THREE layers, and this file is the design's
// documentation of record on how each one is satisfied — deliberately not
// collapsed into one over-broad assertion, because two earlier drafts of
// this gate got that collapse wrong in opposite directions:
//   1. `resolveSources` CANONICALIZES file order — it walks the specs in
//      CONTENT order rather than declared order, so every permutation of a
//      declared source SET collapses to the same file list before the loader
//      ever runs. Test 1 pins this directly. (What that canonical order IS —
//      per-directory-level, files before subdirectories, never a flat sort of
//      absolute paths — is a separate contract, pinned by
//      `source-order.test.ts`. This file only asserts it does not depend on
//      declaration order.)
//   2. The LOADER resolves CONTENT order-independently, given whatever file
//      list it's handed — including an overlay arriving before its base.
//      `_partitionOverlayLast` is the mechanism (stable-partitions
//      overlay-only sources to the end before the parse loop runs); test 2
//      proves it by permuting FILE PATHS directly into `FileSource[]`,
//      bypassing `resolveSources` entirely (routing through it would erase
//      all order variation before the loader ever saw it, and reach
//      overlay-before-base in zero of the six permutations — an earlier
//      draft of this test did exactly that and passed vacuously). Test 2
//      compares CONTENT — each top-level object's own serialization, keyed
//      by name — not the whole tree, for the reason in point 3.
//   3. SIBLING ORDER of unrelated top-level nodes (e.g. which of two
//      unrelated entities appears first in `MetaRoot`'s `children` array)
//      follows raw input order and is DELIBERATELY NOT asserted here. It is
//      not a design claim: `canonicalSerialize`'s own contract
//      (serializer-json.ts:159-167) promises exactly two normalizations —
//      alphabetical `@`-attr keys and a trailing newline — and says nothing
//      about sibling ordering; `serializeNodeInner` emits `ownChildren()` in
//      whatever order the tree holds them. It also doesn't need to be a
//      claim: production never hands the loader a permuted list — layer 1
//      sorts first. A prior draft of test 2 asserted whole-tree
//      `canonicalSerialize` equality across all six permutations and failed
//      on unmodified code for exactly this reason (Order vs Customer swap),
//      even though content resolution was correct in every case — that was
//      the amended test inventing a bar the design never set, not a real
//      defect.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSources, type SourceSpec } from "../src/sources.js";

let root: string;
const write = (rel: string, body: object) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), JSON.stringify(body), "utf8");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "metaobjects-order-"));
  // A base declaration, an overlay onto it, and an independent third file —
  // the shapes whose merge is order-sensitive if anything is.
  write("a/meta.base.json", {
    "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Order", children: [{ "field.string": { name: "id" } }] } }] },
  });
  write("b/meta.overlay.json", {
    "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Order", overlay: true, children: [
        { "field.string": { name: "note" } }] } }] },
  });
  write("c/meta.other.json", {
    "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Customer", children: [{ "field.string": { name: "id" } }] } }] },
  });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

describe("permutations helper", () => {
  test("produces 6 distinct orderings of 3 items", () => {
    // Sanity-check the helper itself, not just its output length: 6 entries
    // that were secretly duplicates would let both gates below pass
    // vacuously without ever exercising a real reordering.
    const items = ["a", "b", "c"];
    const perms = permutations(items);
    expect(perms).toHaveLength(6);
    const distinct = new Set(perms.map((p) => p.join(",")));
    expect(distinct.size).toBe(6);
  });
});

describe("order independence", () => {
  test("resolveSources output is identical across every spec permutation", async () => {
    const specs: SourceSpec[] = [{ path: "a" }, { path: "b" }, { path: "c" }];
    const perms = permutations(specs);
    expect(perms).toHaveLength(6);

    const results = await Promise.all(perms.map((p) => resolveSources(root, p)));
    expect(results).toHaveLength(6);

    // Deep-equal on the FULL ResolvedSource[] — .spec included, not just
    // .file. T4's de-dup tie-break is already content-based (compares
    // JSON.stringify(spec)), so the full structure is order-free too; a
    // .file-only assertion would leave this gate narrower than the property
    // it exists to prove.
    const expected = results[0]!;
    for (let i = 1; i < results.length; i++) {
      expect(
        results[i],
        `permutation ${i} (${JSON.stringify(perms[i])}) diverged from permutation 0 (${JSON.stringify(perms[0])})`,
      ).toEqual(expected);
    }
  });

  test("the loader resolves content order-independently given a permuted file list, including overlay-before-base", async () => {
    const { MetaDataLoader, composeRegistry, coreProviders, canonicalSerialize } =
      await import("@metaobjectsdev/metadata");
    const { FileSource } = await import("@metaobjectsdev/metadata/core");

    // Permute the FILE PATHS directly — deliberately bypassing
    // resolveSources(), whose own sort would erase all order variation
    // before the loader ever saw it (see the file header). Building
    // FileSource[] straight from these paths is what actually reaches an
    // overlay-before-base ordering.
    const basePath = join(root, "a/meta.base.json");
    const overlayPath = join(root, "b/meta.overlay.json");
    const otherPath = join(root, "c/meta.other.json");
    const perms = permutations([basePath, overlayPath, otherPath]);
    expect(perms).toHaveLength(6);

    // Confirm the permutation actually reaches the shape this test exists
    // to cover: half of the six orderings must place the overlay-only file
    // before its base, or this gate would be no stronger than test 1 above.
    const overlayBeforeBase = perms.filter(
      (p) => p.indexOf(overlayPath) < p.indexOf(basePath),
    ).length;
    expect(overlayBeforeBase).toBe(3);

    const label = (p: string[]): string =>
      JSON.stringify(p.map((f) => f.replace(root + "/", "")));

    // Per permutation: a name-keyed map of each top-level object's OWN
    // canonical serialization. Keying by NAME rather than comparing the
    // whole root (or relying on array position) makes the comparison
    // insensitive to sibling order by construction — see point 3 in the
    // file header — while still catching any real content difference,
    // which is the property this test exists to prove.
    const perObject: Map<string, string>[] = [];
    for (const p of perms) {
      const loader = new MetaDataLoader({ registry: composeRegistry(coreProviders) });
      const result = await loader.load(p.map((file) => new FileSource(file)));
      expect(result.errors, `permutation ${label(p)} errored`).toHaveLength(0);

      const byName = new Map<string, string>();
      for (const child of result.root.ownChildren()) {
        byName.set(child.name, canonicalSerialize(child));
      }
      perObject.push(byName);

      // The overlay's contribution must have actually landed on Order in
      // EVERY permutation — this is the assertion that disabling
      // `_partitionOverlayLast` breaks (3 of 6 permutations throw
      // ERR_OVERLAY_NO_TARGET without it, dropping this field entirely; see
      // the break-and-revert evidence in the task report). The empty-errors
      // check above already catches the hard-failure case; this confirms
      // the MERGE actually happened, not merely that nothing errored.
      expect(
        byName.get("Order"),
        `permutation ${label(p)} — Order is missing the overlay's note field`,
      ).toContain('"name": "note"');
    }
    expect(perObject).toHaveLength(6);

    const expected = perObject[0]!;
    for (let i = 1; i < perObject.length; i++) {
      expect(
        perObject[i],
        `permutation ${i} (${label(perms[i]!)}) resolved different CONTENT than permutation 0 (${label(perms[0]!)})`,
      ).toEqual(expected);
    }
  });
});
