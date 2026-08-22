// The raw-document vocabulary rewriter behind `meta upgrade`.
//
// IT CANNOT USE THE LOADER, and that constraint is the whole design. Once an attribute is
// deregistered, metadata carrying it FAILS THE LOAD — that is the point of a retirement. So
// load → transform → canonical-serialize is impossible: the input does not load, and the
// canonical serializer needs a loaded model. Every test below therefore feeds RAW TEXT that
// the current loader would reject.
//
// SURGICAL, NOT PARSE-AND-REPRINT. Adopters author JSONC with comments and meaningful key
// order. A round-trip through JSON.parse/stringify would load-bearing-destroy both while
// reporting success, so the tests pin that unchanged regions come back byte-identical.

import { describe, test, expect } from "bun:test";
import { rewriteDocument } from "../src/vocabulary-rewrite.js";

describe("mechanical rewrites", () => {
  test("drops a retired attribute", () => {
    const src = `{
  "metadata.root": {
    "children": [
      { "requirement.functional": {
          "name": "orderRecord",
          "@statement": "An order records what was bought",
          "@verifiedBy": ["OrderServiceTest"],
          "@level": 4
      }}
    ]
  }
}`;
    const r = rewriteDocument(src, { typeKeyHint: "requirement.functional" });
    expect(r.text).not.toContain("@verifiedBy");
    expect(r.text).toContain('"@statement"');
    expect(r.text).toContain('"@level": 4');
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]?.attr).toBe("verifiedBy");
  });

  test("rewrites key AND value for @readOnly", () => {
    const src = `{ "field.string": { "name": "ref", "@readOnly": true } }`;
    const r = rewriteDocument(src, { typeKeyHint: "field.string" });
    expect(r.text).toContain('"@mutability": "readOnly"');
    expect(r.text).not.toContain("@readOnly");
  });

  test("drops a retired VALUE without touching live values of the same attr", () => {
    const src = `{ "field.uuid": { "name": "refs", "@dbColumnType": "uuid_array" },
  "field.object": { "name": "blob", "@dbColumnType": "jsonb" } }`;
    const r = rewriteDocument(src, { typeKeyHint: "field.uuid" });
    // `jsonb` is live vocabulary on the SAME attribute — dropping it would silently change
    // the column type, which is worse than leaving the retired one in place.
    expect(r.text).toContain('"@dbColumnType": "jsonb"');
    expect(r.text).not.toContain("uuid_array");
  });
});

describe("surgical editing", () => {
  test("preserves comments and key order in the untouched regions", () => {
    const src = `{
  // the ledger's root — do not reorder, the tooling reads this top-down
  "requirement.functional": {
    "name": "orderRecord",       // stable id, cited in tickets
    "@statement": "An order records what was bought",
    "@verifiedBy": ["OrderServiceTest"],
    "@level": 4                  /* organisational level */
  }
}`;
    const r = rewriteDocument(src, { typeKeyHint: "requirement.functional" });
    expect(r.text).toContain("// the ledger's root — do not reorder");
    expect(r.text).toContain("// stable id, cited in tickets");
    expect(r.text).toContain("/* organisational level */");
    // key order intact
    expect(r.text.indexOf('"name"')).toBeLessThan(r.text.indexOf('"@statement"'));
    expect(r.text.indexOf('"@statement"')).toBeLessThan(r.text.indexOf('"@level"'));
  });

  test("a document with nothing to change comes back BYTE-IDENTICAL", () => {
    const src = `{
  "requirement.functional": {
    "name": "orderRecord",
    "@statement": "An order records what was bought",
    "@level": 4
  }
}`;
    const r = rewriteDocument(src, { typeKeyHint: "requirement.functional" });
    expect(r.text).toBe(src);
    expect(r.changes).toHaveLength(0);
    expect(r.refusals).toHaveLength(0);
  });

  test("handles YAML's sigil-free form", () => {
    // YAML authoring is sigil-free — the desugar re-adds `@` when lowering to canonical
    // JSON — so a rename there targets the BARE key.
    const src = `requirement.functional:\n  name: orderRecord\n  verifiedBy:\n    - OrderServiceTest\n  level: 4\n`;
    const r = rewriteDocument(src, { typeKeyHint: "requirement.functional", format: "yaml" });
    expect(r.text).not.toContain("verifiedBy");
    expect(r.text).toContain("level: 4");
  });
});

describe("refusals — the honest half", () => {
  test("REFUSES a judgment case instead of guessing", () => {
    const src = `{ "requirement.functional": { "name": "x", "@status": "abandoned" } }`;
    const r = rewriteDocument(src, { typeKeyHint: "requirement.functional" });
    // Untouched: deleting the node, retyping it, or fixing the residue are all defensible
    // and only a human knows which. Guessing would emit metadata that LOADS and means
    // something different.
    expect(r.text).toBe(src);
    expect(r.changes).toHaveLength(0);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]?.migration).toContain("verified-by-retirement");
  });

  test("a refusal still reports the mechanical changes made alongside it", () => {
    const src = `{ "requirement.functional": {
      "name": "x", "@verifiedBy": ["T"], "@status": "abandoned" } }`;
    const r = rewriteDocument(src, { typeKeyHint: "requirement.functional" });
    expect(r.changes).toHaveLength(1);
    expect(r.refusals).toHaveLength(1);
    expect(r.text).not.toContain("@verifiedBy");
    expect(r.text).toContain('"abandoned"');
  });
});

describe("scoping", () => {
  test("does not touch a name that is live vocabulary on this type", () => {
    // `@unique` is retired on identity.secondary and LIVE on a field. A name-only match
    // would silently delete a valid declaration.
    const src = `{ "field.string": { "name": "email", "@unique": true } }`;
    const r = rewriteDocument(src, { typeKeyHint: "field.string" });
    expect(r.text).toBe(src);
    expect(r.changes).toHaveLength(0);
  });
});
