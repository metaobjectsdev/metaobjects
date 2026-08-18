// server/typescript/packages/sdk/test/order-independence.test.ts
//
// The order-independence gate — the linchpin of the whole design. The
// premise everything else rests on: resolution is a pure function of the
// declared source SET, so the order sources are declared in carries no
// information. That is why the design has no ordered-list semantics, no
// topological sort, no cycle detection, and no diamond-dependency problem.
// This file is what turns that premise from a belief into an enforced
// property, at two tiers:
//   1. resolveSources() itself (T4 already documents this contract; this
//      re-asserts it across all six permutations of three specs, on the
//      FULL ResolvedSource[] — .spec included, not just .file).
//   2. The loaded MODEL — resolveSources() feeding MetaDataLoader, its
//      canonical (own-mode) serialization byte-identical across the same
//      six permutations.
//
// The fixture shape — a base declaration, an overlay onto it, and an
// independent third file — is deliberately the one whose merge is most
// order-sensitive if anything is: an overlay must find its base regardless
// of which file the loader saw first.
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
    const specs: SourceSpec[] = [{ path: "a" }, { path: "b" }, { path: "c" }];
    const perms = permutations(specs);
    expect(perms).toHaveLength(6);
    const distinct = new Set(perms.map((p) => p.map((s) => (s as { path: string }).path).join(",")));
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

  test("the loaded model serializes byte-identically across every permutation", async () => {
    const { MetaDataLoader, composeRegistry, coreProviders, canonicalSerialize } =
      await import("@metaobjectsdev/metadata");
    const { FileSource } = await import("@metaobjectsdev/metadata/core");
    const specs: SourceSpec[] = [{ path: "a" }, { path: "b" }, { path: "c" }];
    const perms = permutations(specs);
    expect(perms).toHaveLength(6);

    const serialized: string[] = [];
    for (const p of perms) {
      const resolved = await resolveSources(root, p);
      const loader = new MetaDataLoader({ registry: composeRegistry(coreProviders) });
      const result = await loader.load(resolved.map((r) => new FileSource(r.file)));
      expect(result.errors).toHaveLength(0);
      serialized.push(canonicalSerialize(result.root));
    }
    expect(serialized).toHaveLength(6);

    for (let i = 1; i < serialized.length; i++) {
      expect(
        serialized[i],
        `permutation ${i} (${JSON.stringify(perms[i])}) serialized differently than permutation 0 (${JSON.stringify(perms[0])})`,
      ).toBe(serialized[0]!);
    }
  });
});
