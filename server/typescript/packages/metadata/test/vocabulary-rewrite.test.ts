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
    const r = rewriteDocument(src);
    expect(r.text).not.toContain("@verifiedBy");
    expect(r.text).toContain('"@statement"');
    expect(r.text).toContain('"@level": 4');
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]?.attr).toBe("verifiedBy");
    // Substring assertions alone are what let the trailing-comma bug through — they were
    // all true of a document that no longer parsed. Every drop case now proves the result
    // is still valid JSON.
    expect(() => JSON.parse(r.text)).not.toThrow();
  });

  test("rewrites key AND value for @readOnly", () => {
    const src = `{ "field.string": { "name": "ref", "@readOnly": true } }`;
    const r = rewriteDocument(src);
    expect(r.text).toContain('"@mutability": "readOnly"');
    expect(r.text).not.toContain("@readOnly");
  });

  test("drops a retired VALUE without touching live values of the same attr", () => {
    const src = `{ "field.uuid": { "name": "refs", "@dbColumnType": "uuid_array" },
  "field.object": { "name": "blob", "@dbColumnType": "jsonb" } }`;
    const r = rewriteDocument(src);
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
    const r = rewriteDocument(src);
    expect(r.text).toContain("// the ledger's root — do not reorder");
    expect(r.text).toContain("// stable id, cited in tickets");
    expect(r.text).toContain("/* organisational level */");
    // key order intact
    expect(r.text.indexOf('"name"')).toBeLessThan(r.text.indexOf('"@statement"'));
    expect(r.text.indexOf('"@statement"')).toBeLessThan(r.text.indexOf('"@level"'));
  });

  // Caught by dogfooding against a real fixture, not by the tests above — the drop cases
  // there all had a following key, so the trailing comma was always there to consume. When
  // the retired attr is LAST, the comma belongs to the PRECEDING key and dropping naively
  // leaves `"...",\n}` — invalid JSON, from a tool whose entire job is producing loadable
  // metadata.
  test("dropping the LAST key does not leave a trailing comma", () => {
    const src = `{
  "requirement.architectural": {
    "name": "MoneyIsExactMinorUnits",
    "@statement": "Amounts are exact integer minor units",
    "@verifiedBy": ["MoneyRoundingTest"]
  }
}`;
    const r = rewriteDocument(src);
    expect(r.text).not.toContain("@verifiedBy");
    // The real assertion: the result must still parse.
    expect(() => JSON.parse(r.text)).not.toThrow();
    expect(JSON.parse(r.text)["requirement.architectural"]["@statement"]).toBe(
      "Amounts are exact integer minor units",
    );
  });

  test("dropping the ONLY key leaves a valid empty object", () => {
    const src = `{ "requirement.functional": { "@verifiedBy": ["T"] } }`;
    const r = rewriteDocument(src);
    expect(() => JSON.parse(r.text)).not.toThrow();
  });

  test("a document with nothing to change comes back BYTE-IDENTICAL", () => {
    const src = `{
  "requirement.functional": {
    "name": "orderRecord",
    "@statement": "An order records what was bought",
    "@level": 4
  }
}`;
    const r = rewriteDocument(src);
    expect(r.text).toBe(src);
    expect(r.changes).toHaveLength(0);
    expect(r.refusals).toHaveLength(0);
  });

  // YAML is NOT rewritten here, and must not be touched at all. A hand-rolled YAML mode
  // shipped and corrupted files: a multi-item block sequence lost every item but the first
  // (the value scanner stops at a newline), and the dominant in-repo authoring style — flow
  // mappings, `{ name: x, readOnly: true }` — was not matched at all, so the rename silently
  // did nothing. `meta upgrade` refuses YAML files by name instead; this pins that the
  // rewriter leaves such text strictly alone rather than half-editing it.
  test("leaves YAML text untouched rather than half-editing it", () => {
    const src = `requirement.functional:\n  name: orderRecord\n  verifiedBy:\n    - OrderServiceTest\n    - SecondTest\n  level: 4\n`;
    const r = rewriteDocument(src);
    expect(r.text).toBe(src);
    expect(r.changes).toHaveLength(0);
  });
});

describe("refusals — the honest half", () => {
  test("REFUSES a judgment case instead of guessing", () => {
    // `@status: abandoned` was the canonical judgement case until FR-039 gave the
    // capability a prescriptive name and made the edit determinate. A case that is
    // STILL judgement: `identity.secondary @unique` — whether the node becomes an
    // `index.lookup` or stays a unique key is the author's call, and only they know.
    const src = `{ "identity.secondary": { "name": "byEmail", "@unique": true, "@fields": ["email"] } }`;
    const r = rewriteDocument(src);
    expect(r.text).toBe(src);
    expect(r.changes).toHaveLength(0);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]?.migration).toContain("identity-secondary-to-index-lookup");
  });

  test("@status: abandoned is MECHANICAL now, and takes @implementedBy with it (FR-039)", () => {
    const src = `{ "requirement.functional": { "name": "x", "@status": "abandoned", "@implementedBy": ["a::B"] } }`;
    const r = rewriteDocument(src);
    expect(r.refusals).toHaveLength(0);
    expect(r.text).toContain('"@status": "retired"');
    // Both passes run in ONE invocation. If only the status moved, `meta upgrade --apply`
    // would exit 0 on a document that still does not load — the #342 failure exactly.
    expect(r.text).not.toContain("@implementedBy");
  });

  test("a refusal still reports the mechanical changes made alongside it", () => {
    const src = `{ "metadata.root": { "children": [
      { "requirement.functional": { "name": "x", "@verifiedBy": ["T"], "@status": "live", "@statement": "s" } },
      { "identity.secondary": { "name": "byEmail", "@unique": true, "@fields": ["email"] } }
    ]}}`;
    const r = rewriteDocument(src);
    expect(r.changes).toHaveLength(1);   // @verifiedBy dropped
    expect(r.refusals).toHaveLength(1);  // @unique refused
    expect(r.text).not.toContain("@verifiedBy");
    expect(r.text).toContain('"@unique"');
  });
});

describe("scoping", () => {
  test("does not touch a name that is live vocabulary on this type", () => {
    // `@unique` is retired on identity.secondary and LIVE on a field. A name-only match
    // would silently delete a valid declaration.
    const src = `{ "field.string": { "name": "email", "@unique": true } }`;
    const r = rewriteDocument(src);
    expect(r.text).toBe(src);
    expect(r.changes).toHaveLength(0);
  });

  // The case the type-scope test above could NOT see, because it fed a document containing
  // only the live type. The scope of a retirement is a property of where the attribute
  // sits, so a retired-elsewhere name sitting beside its retired type must still be left
  // alone — the earlier file-level scoping refused this field's `@unique` at exit code 1,
  // and with a `dropAttr` entry the same mechanism would have DELETED it.
  test("a retired name on a LIVE type is untouched even when its retired type is present", () => {
    const src = `{
  "metadata.root": { "children": [
    { "field.string": { "name": "email", "@unique": true } },
    { "identity.secondary": { "name": "byEmail", "@fields": ["email"] } }
  ]}
}`;
    const r = rewriteDocument(src);
    expect(r.text).toBe(src);
    expect(r.changes).toHaveLength(0);
    expect(r.refusals).toHaveLength(0);
  });

  // A wildcard entry (`requirement.*`) governs every subtype. Scoping per FILE meant one
  // pass per subtype key present, so a single occurrence was reported once per pass — two
  // refusals, and a summary claiming two declarations, for one line of metadata.
  test("reports ONE change per occurrence, not one per subtype in the file", () => {
    // Was a refusal test; `@status: abandoned` rewrites now (FR-039), so the same
    // per-occurrence property is asserted on the CHANGE list instead. The bug it
    // guards is unchanged: scoping per FILE ran one pass per subtype key present,
    // so one line of metadata was reported once per pass.
    const src = `{
  "metadata.root": { "children": [
    { "requirement.functional": { "name": "a", "@status": "abandoned" } },
    { "requirement.architectural": { "name": "b", "@statement": "always" } }
  ]}
}`;
    const r = rewriteDocument(src);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]?.attr).toBe("status");
  });
});

describe("nothing exits clean while the metadata still will not load", () => {
  // A retired SUBTYPE was filtered out of the rewriter entirely (the applicable filter
  // required an `attr`), so `meta upgrade` reported "no retired vocabulary found" and
  // exited 0 on a document that fails ERR_UNKNOWN_SUBTYPE.
  test("REFUSES a retired subtype instead of ignoring it", () => {
    const src = `{ "origin.collection": { "@via": "Program.weeks" } }`;
    const r = rewriteDocument(src);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]?.subject).toBe("origin.collection");
    expect(r.refusals[0]?.migration).toContain("origin-collection-retirement");
    expect(r.text).toBe(src);
  });

  // `@readOnly` is deregistered for EVERY value. The `false` arm fell through to `continue`,
  // so the attribute survived, the load kept failing, and the run reported success.
  test("drops @readOnly: false rather than silently skipping it", () => {
    const src = `{ "field.string": { "name": "x", "@readOnly": false } }`;
    const r = rewriteDocument(src);
    expect(r.text).not.toContain("@readOnly");
    expect(r.changes).toHaveLength(1);
    expect(() => JSON.parse(r.text)).not.toThrow();
  });
});
