// `meta upgrade` must not answer "nothing to rewrite" about the change the 1.0 guide leads with.
//
// An estate declaring `{"object.base": {"name": "BaseEntity", …}}` gets
// `ERR_ABSTRACT_SUBTYPE_AUTHORED` from the loader (§10A, the flagship metadata migration of the
// line) — and `meta upgrade` reported "nothing to rewrite (5 file(s) checked)", exit 0. The one
// command whose job is "what does the new version need me to change?" said "nothing" about the
// single change it needed, and the adopter met the load failure afterwards, with reason to
// distrust the tool. Same shape as #339.
//
// It is a REFUSAL, not a rewrite: `object.base` → `entity | value | projection` is a decision
// about what the node IS, which no rewriter can make.
import { describe, test, expect } from "bun:test";
import { rewriteDocument } from "../src/vocabulary-rewrite.js";
import { rewriteYamlDocument } from "../src/core/vocabulary-rewrite-yaml.js";

const ANCHORS = ["object", "field", "source"];

const JSON_DOC = JSON.stringify(
  {
    "metadata.root": {
      package: "acme",
      children: [
        { "object.base": { name: "BaseEntity", abstract: true, children: [{ "field.long": { name: "id" } }] } },
      ],
    },
  },
  null,
  2,
);

const YAML_DOC = `metadata.root:
  package: acme
  children:
    - object.base:
        name: BaseEntity
        abstract: true
`;

describe("an authored <type>.base is refused by meta upgrade, in both document formats", () => {
  test("JSON: refused, with the file line and the guide", () => {
    const r = rewriteDocument(JSON_DOC, { abstractAnchorTypes: ANCHORS });
    expect(r.changes).toEqual([]);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]!.subject).toBe("object.base");
    expect(r.refusals[0]!.line).toBeGreaterThan(0);
    expect(r.refusals[0]!.migration).toContain("base-subtypes-are-not-authorable");
    // Never silently "fixed": choosing the concrete subtype is the adopter's decision.
    expect(r.text).toBe(JSON_DOC);
  });

  test("YAML: the same rule, from the same option", () => {
    const r = rewriteYamlDocument(YAML_DOC, { abstractAnchorTypes: ANCHORS });
    expect(r.unparseable).toBeFalsy();
    expect(r.refusals.map((f) => f.subject)).toEqual(["object.base"]);
    expect(r.text).toBe(YAML_DOC);
  });

  test("a caller that cannot say which types have anchors gets NO anchor refusals", () => {
    // The honest default. These rewriters are registry-free on purpose, and whether `base`
    // anchors anything is a registry question — a third-party provider may register `base`
    // as a type's ONLY member, where refusing it would remove a capability nobody asked to
    // remove. So the fact is supplied by the caller or not used at all.
    expect(rewriteDocument(JSON_DOC, {}).refusals).toEqual([]);
    expect(rewriteYamlDocument(YAML_DOC, {}).refusals).toEqual([]);
  });

  test("a type NOT named as an anchor is left alone", () => {
    const r = rewriteDocument(JSON_DOC, { abstractAnchorTypes: ["field"] });
    expect(r.refusals).toEqual([]);
  });

  test("a CONCRETE subtype of an anchor type is not refused", () => {
    // The rule is about the `base` subtype, never about the type carrying one.
    const doc = JSON.stringify({
      "metadata.root": { package: "acme", children: [{ "object.entity": { name: "User" } }] },
    });
    expect(rewriteDocument(doc, { abstractAnchorTypes: ANCHORS }).refusals).toEqual([]);
  });
});
