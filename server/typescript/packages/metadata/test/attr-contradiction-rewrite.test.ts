// `meta upgrade` resolving an ATTRIBUTE CONTRADICTION — two live attrs on one node.
//
// The case is #342: an index key is `@fields` XOR `@expr`, and a node declaring both stopped
// loading in 0.24.1. It is the first entry in `attr-contradictions.ts` and the first thing
// `meta upgrade` fixes that is not a retirement.
//
// WHY DROPPING `@fields` IS NOT A GUESS. The pair LOADED before 0.24.1 and `@fields` was
// silently discarded — `migrate-ts` runs `columns: expr ? [] : cols` — so the index in the
// adopter's database is the expression one. Dropping `@fields` reproduces what is deployed;
// dropping `@expr` would invent a different index and emit a migration against live data.
//
// THE TEST THAT MATTERS IS THE SIBLING ONE. A first attempt matched by proximity ("a
// `fields` with an `expr` within three lines") and deleted a `fields` whose neighbouring
// `expr` belonged to a DIFFERENT node, producing metadata that failed to load with
// "declares no key". Every fixture here therefore puts a second keyed node next to the first.

import { describe, test, expect } from "bun:test";
import { rewriteDocument } from "../src/vocabulary-rewrite.js";

/** Two keyed children on one entity: the first contradicts, the second is a plain index. */
const SIBLINGS = `{
  "metadata.root": {
    "children": [
      { "object.entity": {
          "name": "Account",
          "children": [
            { "field.string": { "name": "email" } },
            { "field.string": { "name": "region" } },
            { "index.lookup": {
                "name": "byEmailLower",
                "@fields": ["email"],
                "@expr": "lower(email)"
            }},
            { "index.lookup": {
                "name": "byRegion",
                "@fields": ["region"]
            }}
          ]
      }}
    ]
  }
}`;

describe("the index key is @fields XOR @expr", () => {
  test("drops @fields from the node that also declares @expr", () => {
    const r = rewriteDocument(SIBLINGS);
    expect(r.changes.map((c) => c.attr)).toEqual(["fields"]);
    expect(r.text).toContain('"@expr": "lower(email)"');
    expect(() => JSON.parse(r.text)).not.toThrow();
  });

  // The proximity bug, pinned. `byRegion` is a legal plain-column index three lines from an
  // `@expr` that is not its own; taking its `@fields` produces a node with no key at all.
  test("leaves a SIBLING node's @fields alone, however close the @expr sits", () => {
    const r = rewriteDocument(SIBLINGS);
    const parsed = JSON.parse(r.text);
    const kids = parsed["metadata.root"].children[0]["object.entity"].children;
    expect(kids[2]["index.lookup"]["@fields"]).toBeUndefined();
    expect(kids[3]["index.lookup"]["@fields"]).toEqual(["region"]);
  });

  test("applies to identity.secondary too — uniqueness lives in the TYPE (ADR-0040)", () => {
    const src = `{ "identity.secondary": {
      "name": "uqEmail", "@fields": ["email"], "@expr": "lower(email)" } }`;
    const r = rewriteDocument(src);
    expect(r.changes).toHaveLength(1);
    expect(JSON.parse(r.text)["identity.secondary"]["@fields"]).toBeUndefined();
    expect(JSON.parse(r.text)["identity.secondary"]["@expr"]).toBe("lower(email)");
  });

  // identity.primary and identity.reference carry no @expr at all, so a @fields there is
  // the only key it could have. A scope that reached them would delete it.
  test("never touches identity.primary", () => {
    const src = `{ "object.entity": { "name": "A", "children": [
      { "identity.primary": { "name": "pk", "@fields": ["id"] } },
      { "index.lookup": { "name": "x", "@expr": "lower(email)" } }
    ]}}`;
    const r = rewriteDocument(src);
    expect(r.changes).toHaveLength(0);
    expect(r.text).toBe(src);
  });
});

describe("the two sides are asked different questions", () => {
  // Loader Rule 1a keys the contradiction on PRESENCE, precisely because `@fields: []`
  // beside `@expr` is the spelling where the discard is TOTAL — and keying on non-emptiness
  // let exactly that case load clean.
  test("an EMPTY @fields beside @expr is still a declaration of both, and goes", () => {
    const src = `{ "index.lookup": { "name": "x", "@fields": [], "@expr": "lower(email)" } }`;
    const r = rewriteDocument(src);
    expect(r.changes).toHaveLength(1);
    expect(JSON.parse(r.text)["index.lookup"]["@fields"]).toBeUndefined();
  });

  // The mirror image, and the one that would corrupt a working document. A blank `@expr`
  // supplies no key, so the loader does NOT refuse this node — it is a plain column index
  // and `@fields` is the only key it has.
  test("a BLANK @expr beside @fields is not a contradiction, and @fields stays", () => {
    const src = `{ "index.lookup": { "name": "x", "@fields": ["email"], "@expr": "   " } }`;
    const r = rewriteDocument(src);
    expect(r.changes).toHaveLength(0);
    expect(r.text).toBe(src);
  });
});

describe("surgical, like every other edit here", () => {
  test("comments and key order survive in the untouched regions", () => {
    const src = `{
  // Do not reorder — matches meta gen output.
  "index.lookup": {
    "name": "byEmailLower",
    "@fields": ["email"],
    "@expr": "lower(email)",
    "@using": "btree"
  }
}`;
    const r = rewriteDocument(src);
    expect(r.text).toContain("// Do not reorder — matches meta gen output.");
    expect(r.text).toContain('"@using": "btree"');
    expect(r.text).not.toContain('"@fields"');
  });

  test("dropping @fields as the LAST key leaves parseable JSON", () => {
    const src = `{ "index.lookup": { "name": "x", "@expr": "lower(email)", "@fields": ["email"] } }`;
    const r = rewriteDocument(src);
    expect(() => JSON.parse(r.text)).not.toThrow();
    expect(JSON.parse(r.text)["index.lookup"]["@expr"]).toBe("lower(email)");
  });

  test("--to holds the fix back before the release that started refusing it", () => {
    const src = `{ "index.lookup": { "name": "x", "@fields": ["email"], "@expr": "lower(email)" } }`;
    expect(rewriteDocument(src, { maxVersion: "0.24.0" }).changes).toHaveLength(0);
    expect(rewriteDocument(src, { maxVersion: "0.24.1" }).changes).toHaveLength(1);
  });
});
