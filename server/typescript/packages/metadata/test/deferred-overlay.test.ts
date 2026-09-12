// ADR-0055 — overlay application is a DEFERRED pass.
//
// `extends` has always resolved after every source is parsed; `overlay: true`
// resolved eagerly against the accumulating root, so whether an overlay worked
// depended on file order. #160 partitioned overlay-ONLY sources to the end, but
// its predicate is file-level: a MIXED file (plain + overlay declarations in one
// file) was treated as a base and never moved, so its overlay could be parsed
// before the source declaring its target.
//
// These tests assert the ADR-0055 guarantees at the loader's public boundary —
// observable tree and errors, never internals — so they survive the partition's
// deletion and the parser refactor underneath them:
//
//   G1 plain before overlay · G2 overlays in source order · G3 whole-unit
//   G4 order independence    · G5 supers after overlays
import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import type { MetaRoot } from "../src/shared/meta-root.js";

const PKG = "acme";

/** A source whose id fixes its position in the explicit load list. */
const src = (id: string, body: unknown) =>
  new InMemoryStringSource(JSON.stringify(body), { id });

const doc = (children: unknown[]) => ({
  "metadata.root": { package: PKG, children },
});

const obj = (name: string, children: unknown[], overlay = false) => ({
  "object.value": overlay
    ? { name, overlay: true, children }
    : { name, children },
});

const field = (name: string, extra: Record<string, unknown> = {}) => ({
  "field.string": { name, ...extra },
});

async function load(sources: InMemoryStringSource[]) {
  return new MetaDataLoader({ strict: false }).load(sources);
}

/** Field names of a top-level object, in tree order. */
function fieldsOf(root: MetaRoot, name: string): string[] {
  const o = root.objects().find((x) => x.name === name);
  if (o === undefined) return ["<object missing>"];
  return o.childrenOfType("field").map((f) => f.name);
}

function codesOf(errors: unknown[]): string[] {
  return errors.map((e) => (e as { code?: string }).code ?? "<no code>");
}

// A mixed file: one plain declaration (X) plus an overlay of Y.
const MIXED = doc([
  obj("X", [field("xid")]),
  obj("Y", [field("ov")], true),
]);
const BASE_Y = doc([obj("Y", [field("id")])]);

describe("ADR-0055 — deferred overlay application", () => {
  test("G1/G4 — a MIXED file's overlay resolves when its base is in a LATER source", async () => {
    const r = await load([src("a-mixed.json", MIXED), src("z-base.json", BASE_Y)]);

    expect(codesOf(r.errors)).toEqual([]);
    // The base's children come first, then the overlay's contribution.
    expect(fieldsOf(r.root, "Y")).toEqual(["id", "ov"]);
    // The mixed file's OTHER declaration must survive — the old eager throw
    // aborted the whole source, so X vanished and cascaded further errors.
    expect(fieldsOf(r.root, "X")).toEqual(["xid"]);
  });

  test("G4 — the same two sources in the opposite order produce a BYTE-IDENTICAL tree", async () => {
    const forward = await load([src("a-mixed.json", MIXED), src("z-base.json", BASE_Y)]);
    const reverse = await load([src("a-base.json", BASE_Y), src("z-mixed.json", MIXED)]);

    expect(codesOf(forward.errors)).toEqual([]);
    expect(codesOf(reverse.errors)).toEqual([]);

    const strip = (s: string) => s.replace(/"files":\s*\[[^\]]*\]/g, '"files":[]');
    const yOf = (root: MetaRoot) =>
      strip(canonicalSerialize(root.objects().find((o) => o.name === "Y")!));

    expect(yOf(reverse.root)).toBe(yOf(forward.root));
  });

  test("G4 — an overlay preceding its base INSIDE ONE FILE resolves to one node", async () => {
    const r = await load([
      src("one.json", doc([obj("Y", [field("ov")], true), obj("Y", [field("id")])])),
    ]);

    expect(codesOf(r.errors)).toEqual([]);
    // Exactly one Y — not two silent siblings (Python's pre-ADR behaviour).
    expect(r.root.objects().filter((o) => o.name === "Y")).toHaveLength(1);
    expect(fieldsOf(r.root, "Y")).toEqual(["id", "ov"]);
  });

  test("G3 — a NESTED overlay under a PLAIN parent is its own unit and resolves against a later base", async () => {
    const r = await load([
      // C is plain; its `email` child is an overlay whose target does not exist yet.
      src("a-nested.json", doc([obj("C", [field("email", { "@maxLength": 80, overlay: true })])])),
      src("z-base.json", doc([obj("C", [field("email")])])),
    ]);

    expect(codesOf(r.errors)).toEqual([]);
    const c = r.root.objects().find((o) => o.name === "C");
    expect(c).toBeDefined();
    expect(c!.childrenOfType("field").map((f) => f.name)).toEqual(["email"]);
    // The overlay's attribute landed on the base's field.
    expect(canonicalSerialize(c!)).toContain('"@maxLength"');
  });

  test("G2 — two overlay sources apply in source order", async () => {
    const r = await load([
      src("a-base.json", BASE_Y),
      src("m-first.json", doc([obj("Y", [field("first")], true)])),
      src("z-second.json", doc([obj("Y", [field("second")], true)])),
    ]);

    expect(codesOf(r.errors)).toEqual([]);
    expect(fieldsOf(r.root, "Y")).toEqual(["id", "first", "second"]);
  });

  test("Q3 ruling — every plain declaration precedes every overlay, including a LATER unflagged redeclaration", async () => {
    // §3.2: the one interleaving that moves on already-loading input.
    // Before ADR-0055 this was [id, ov, late]; the ruling makes it [id, late, ov].
    const r = await load([
      src("meta.a.json", BASE_Y),
      src("meta.b.json", MIXED),
      src("meta.c.json", doc([obj("Y", [field("late")])])),
    ]);

    expect(codesOf(r.errors)).toEqual([]);
    expect(fieldsOf(r.root, "Y")).toEqual(["id", "late", "ov"]);
  });

  test("an overlay with no target anywhere is ERR_OVERLAY_NO_TARGET, reported without discarding its source", async () => {
    const r = await load([src("a-mixed.json", MIXED)]); // no base for Y, ever

    expect(codesOf(r.errors)).toEqual(["ERR_OVERLAY_NO_TARGET"]);
    // The envelope is a reference-resolution failure (ADR-0009 FR5d).
    const source = (r.errors[0] as unknown as { source?: { format?: string; files?: string[] } }).source;
    expect(source?.format).toBe("resolved");
    expect(source?.files).toEqual(["a-mixed.json"]);
    // The sibling declaration in the SAME file still loaded.
    expect(fieldsOf(r.root, "X")).toEqual(["xid"]);
  });

  test("G5 — a node an overlay contributes is visible to deferred super resolution", async () => {
    const r = await load([
      // Base for the overlay to land on, plus a node extending what it adds.
      src("a-mixed.json", doc([
        obj("Y", [field("ov")], true),
        { "object.value": { name: "Z", extends: "acme::Y", children: [] } },
      ])),
      src("z-base.json", BASE_Y),
    ]);

    expect(codesOf(r.errors)).toEqual([]);
    expect(fieldsOf(r.root, "Y")).toEqual(["id", "ov"]);
  });
});
