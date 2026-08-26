// The YAML arm of `meta upgrade` resolving the `@fields` XOR `@expr` contradiction (#342).
//
// YAML is the authoring front-end (ADR-0006), so an adopter estate is more likely to hit
// this here than in canonical JSON — and the estate that surfaced the gap was YAML.
//
// SIGIL-FREE KEYS. The desugar re-adds the `@`, so authored YAML writes `fields:` and
// `expr:`. An authored `@fields:` still has to match, or the fix silently skips the one
// author who wrote it the other way.

import { describe, test, expect } from "bun:test";
import { parse } from "yaml";
import { rewriteYamlDocument } from "../src/core/vocabulary-rewrite-yaml.js";

const BLOCK = `metadata.root:
  package: acme::shop
  children:
    - object.entity:
        name: Account
        children:
          - field.string:
              name: email
          - field.string:
              name: region
          - index.lookup:
              name: byEmailLower
              fields:
                - email
              expr: lower(email)
          - index.lookup:
              name: byRegion
              fields:
                - region
`;

describe("the index key is fields XOR expr — block style", () => {
  test("drops fields from the node that also declares expr", () => {
    const r = rewriteYamlDocument(BLOCK);
    expect(r.unparseable).toBe(false);
    expect(r.changes.map((c) => c.attr)).toEqual(["fields"]);
    expect(r.text).toContain("expr: lower(email)");
  });

  // The whole reason this is matched per NODE. `byRegion` is a legal plain-column index
  // whose `fields:` sits three lines below an `expr:` that is not its own.
  test("leaves the SIBLING node's fields alone", () => {
    const r = rewriteYamlDocument(BLOCK);
    const kids = parse(r.text)["metadata.root"].children[0]["object.entity"].children;
    expect(kids[2]["index.lookup"].fields).toBeUndefined();
    expect(kids[2]["index.lookup"].expr).toBe("lower(email)");
    expect(kids[3]["index.lookup"].fields).toEqual(["region"]);
  });

  // A block sequence value ends ON its closing newline. Consuming another terminator here
  // is the multi-item corruption this arm exists to avoid, arriving by a different route —
  // so the key AFTER the dropped one must survive intact.
  test("dropping a multi-line fields: does not eat the following key", () => {
    const src = `index.lookup:
  name: byEmailLower
  fields:
    - email
    - region
  expr: lower(email)
  using: btree
`;
    const r = rewriteYamlDocument(src);
    const node = parse(r.text)["index.lookup"];
    expect(node.fields).toBeUndefined();
    expect(node.expr).toBe("lower(email)");
    expect(node.using).toBe("btree");
    expect(node.name).toBe("byEmailLower");
  });
});

describe("flow style, the other half of the authoring surface", () => {
  test("drops fields from a flow mapping without mangling the separators", () => {
    const src = `index.lookup: { name: x, fields: [email], expr: lower(email) }\n`;
    const r = rewriteYamlDocument(src);
    const node = parse(r.text)["index.lookup"];
    expect(node.fields).toBeUndefined();
    expect(node.expr).toBe("lower(email)");
    expect(node.name).toBe("x");
  });
});

describe("the two sides are asked different questions", () => {
  test("an EMPTY fields beside expr is still a declaration of both, and goes", () => {
    const src = `index.lookup: { name: x, fields: [], expr: lower(email) }\n`;
    const r = rewriteYamlDocument(src);
    expect(r.changes).toHaveLength(1);
    expect(parse(r.text)["index.lookup"].fields).toBeUndefined();
  });

  test("a BLANK expr beside fields is not a contradiction — the document is untouched", () => {
    const src = `index.lookup: { name: x, fields: [email], expr: "   " }\n`;
    const r = rewriteYamlDocument(src);
    expect(r.changes).toHaveLength(0);
    expect(r.text).toBe(src);
  });

  test("a MISSING expr value is not a contradiction either", () => {
    const src = `index.lookup:\n  name: x\n  fields:\n    - email\n  expr:\n`;
    const r = rewriteYamlDocument(src);
    expect(r.changes).toHaveLength(0);
    expect(r.text).toBe(src);
  });
});

describe("scope and sigil", () => {
  test("applies to identity.secondary and never to identity.primary", () => {
    const src = `object.entity:
  name: A
  children:
    - identity.primary: { name: pk, fields: [id] }
    - identity.secondary: { name: uq, fields: [email], expr: lower(email) }
`;
    const r = rewriteYamlDocument(src);
    expect(r.changes).toHaveLength(1);
    const kids = parse(r.text)["object.entity"].children;
    expect(kids[0]["identity.primary"].fields).toEqual(["id"]);
    expect(kids[1]["identity.secondary"].fields).toBeUndefined();
  });

  test("an authored @ sigil is matched rather than skipped", () => {
    const src = `index.lookup: { name: x, "@fields": [email], "@expr": lower(email) }\n`;
    const r = rewriteYamlDocument(src);
    expect(r.changes).toHaveLength(1);
    expect(r.text).not.toContain("@fields");
    expect(r.text).toContain("@expr");
  });
});
