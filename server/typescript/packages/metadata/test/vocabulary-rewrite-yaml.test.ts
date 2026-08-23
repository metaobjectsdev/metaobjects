// The YAML arm of `meta upgrade`'s rewriter (#339).
//
// The cases here are chosen against the way this repo's own YAML is actually authored
// (`examples/advanced-modeling/metaobjects/*.yaml`): sigil-free keys, children as a sequence
// of single-key mappings, and node bodies written as FLOW mappings
// (`- field.string: { name: title, readOnly: true }`).
//
// Two of them are regression pins for the hand-rolled attempt that had to be withdrawn:
// a multi-item block sequence value (it kept only the first item) and a flow mapping (it
// matched nothing at all, so the rewrite silently did nothing). Both are span-extent
// problems, which is why this arm asks the parser for the extent instead of scanning.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "../src/index.js";
import { rewriteYamlDocument } from "../src/core/vocabulary-rewrite-yaml.js";

describe("rewriteYamlDocument", () => {
  test("renames a retired attr in a BLOCK mapping and leaves everything else byte-identical", () => {
    const src = [
      "# a leading comment that must survive",
      "metadata:",
      "  package: acme::app",
      "  children:",
      "    - requirement.functional:",
      "        name: R1",
      "        # an interior comment, also load-bearing",
      "        violation: a user checks out with an empty cart",
      "        level: L4",
      "",
    ].join("\n");

    const r = rewriteYamlDocument(src);

    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ from: "violation", to: "counterexample", line: 8 });
    expect(r.refusals).toEqual([]);
    expect(r.text).toBe(src.replace("violation:", "counterexample:"));
  });

  test("renames inside a FLOW mapping — the dominant authoring style, and invisible to the withdrawn scanner", () => {
    const src = [
      "metadata:",
      "  children:",
      "    - requirement.functional: { name: R2, violation: nope, level: L4 }",
      "",
    ].join("\n");

    const r = rewriteYamlDocument(src);

    expect(r.changes).toHaveLength(1);
    expect(r.text).toContain("{ name: R2, counterexample: nope, level: L4 }");
  });

  test("drops an attr whose value is a MULTI-ITEM block sequence, taking every item", () => {
    // The withdrawn attempt kept `- CheckoutIT` and `- CartTest`, because a hand-written
    // value scanner stops at the first newline. The parser reports the whole extent.
    const src = [
      "metadata:",
      "  children:",
      "    - requirement.functional:",
      "        name: R3",
      "        verifiedBy:",
      "          - CartTest",
      "          - CheckoutIT",
      "          - EmptyCartIT",
      "        level: L4",
      "",
    ].join("\n");

    const r = rewriteYamlDocument(src);

    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ to: "(removed)" });
    expect(r.text).not.toContain("verifiedBy");
    expect(r.text).not.toContain("CartTest");
    expect(r.text).not.toContain("CheckoutIT");
    expect(r.text).not.toContain("EmptyCartIT");
    // The surrounding keys are untouched and still parse as their own lines.
    expect(r.text).toContain("        name: R3\n        level: L4\n");
  });

  test("drops a MIDDLE key of a flow mapping without stranding a comma", () => {
    const src = "metadata:\n  children:\n    - requirement.functional: { name: R4, supersededBy: R1, level: L4 }\n";
    const r = rewriteYamlDocument(src);
    expect(r.text).toContain("{ name: R4, level: L4 }");
  });

  test("drops the LAST key of a flow mapping by taking the PRECEDING comma", () => {
    const src = "metadata:\n  children:\n    - requirement.functional: { name: R5, supersededBy: R1 }\n";
    const r = rewriteYamlDocument(src);
    expect(r.text).toContain("{ name: R5 }");
    // Whatever it produced must still be valid YAML — a fixer may never emit a broken file.
    expect(() => rewriteYamlDocument(r.text)).not.toThrow();
    expect(rewriteYamlDocument(r.text).changes).toEqual([]);
  });

  test("refuses a retirement that needs a human decision instead of guessing", () => {
    const src = "metadata:\n  children:\n    - requirement.functional: { name: R6, status: abandoned }\n";
    const r = rewriteYamlDocument(src);
    expect(r.changes).toEqual([]);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toMatchObject({ subject: "@status", value: "abandoned", since: "0.24.0" });
    expect(r.text).toBe(src);
  });

  test("scopes every occurrence by its enclosing node, never by the file", () => {
    // `violation` is retired on `requirement.*`. The same key under a field is not this
    // vocabulary at all, and branding it retired would be worse than the generic message.
    const src = [
      "metadata:",
      "  children:",
      "    - object.entity:",
      "        name: Cart",
      "        children:",
      "          - field.string: { name: violation }",
      "          - field.string: { name: note, violation: keep-me }",
      "",
    ].join("\n");

    const r = rewriteYamlDocument(src);
    expect(r.changes).toEqual([]);
    expect(r.refusals).toEqual([]);
    expect(r.text).toBe(src);
  });

  test("rewrites @readOnly's key AND value, and drops the arm that has no replacement", () => {
    const src = [
      "metadata:",
      "  children:",
      "    - object.entity:",
      "        name: Cart",
      "        children:",
      "          - field.string: { name: title, readOnly: true }",
      "          - field.string: { name: code, readOnly: false }",
      "",
    ].join("\n");

    const r = rewriteYamlDocument(src);

    expect(r.text).toContain("{ name: title, mutability: readOnly }");
    // `readOnly: false` was the default; inventing a mutability the author never stated
    // would be a guess, so it goes.
    expect(r.text).toContain("{ name: code }");
    expect(r.changes).toHaveLength(2);
  });

  test("reports a retired SUBTYPE, which no attribute rewrite can fix", () => {
    const src = [
      "metadata:",
      "  children:",
      "    - object.projection:",
      "        name: CartView",
      "        children:",
      "          - field.string:",
      "              name: labels",
      "              children:",
      "                - origin.collection: { via: Cart.items, of: Item.label }",
      "",
    ].join("\n");

    const r = rewriteYamlDocument(src);
    expect(r.changes).toEqual([]);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toMatchObject({ subject: "origin.collection" });
  });

  test("is idempotent — a second pass over its own output changes nothing", () => {
    const src = [
      "metadata:",
      "  children:",
      "    - requirement.functional:",
      "        name: R7",
      "        violation: x",
      "        verifiedBy:",
      "          - A",
      "          - B",
      "    - object.entity:",
      "        name: Cart",
      "        children:",
      "          - field.string: { name: t, readOnly: true }",
      "",
    ].join("\n");

    const once = rewriteYamlDocument(src);
    expect(once.changes.length).toBeGreaterThan(0);
    const twice = rewriteYamlDocument(once.text);
    expect(twice.changes).toEqual([]);
    expect(twice.text).toBe(once.text);
  });

  test("respects --to by leaving a later retirement alone", () => {
    const src = "metadata:\n  children:\n    - requirement.functional: { name: R8, violation: x }\n";
    // `violation` retired in 0.24.0, so a 0.23.0 window must not touch it.
    expect(rewriteYamlDocument(src, { maxVersion: "0.23.0" }).changes).toEqual([]);
    expect(rewriteYamlDocument(src, { maxVersion: "0.24.0" }).changes).toHaveLength(1);
  });

  test("never edits a document it could not parse", () => {
    const broken = "metadata:\n  children:\n   - requirement.functional: { name: R9, violation: x\n";
    const r = rewriteYamlDocument(broken);
    expect(r.text).toBe(broken);
    expect(r.changes).toEqual([]);
  });

  // The claim `meta upgrade` actually makes is not "the text changed" but "your metadata
  // loads now". Asserting the absence of one error code would pass with the rewriter gutted,
  // so this asserts the load is CLEAN — and first proves the input really did fail, since a
  // fixture that loaded all along would make the second half vacuous.
  test("its output LOADS — the input fails first, so the assertion is not vacuous", async () => {
    const src = [
      "metadata:",
      "  package: acme::app",
      "  children:",
      "    - object.entity:",
      "        name: Cart",
      "        children:",
      "          - source.rdb: { table: carts }",
      "          - field.uuid: { name: id }",
      "          - field.string: { name: title, readOnly: true }",
      "          - identity.primary: { name: id, fields: id, generation: uuid }",
      "    - requirement.functional:",
      "        name: CheckoutRequiresItems",
      "        statement: Checkout must reject a cart holding no items.",
      "        level: 4",
      "        status: live",
      "        implementedBy: Cart",
      "        violation: a user checks out with an empty cart",
      "        verifiedBy:",
      "          - CartTest",
      "          - CheckoutIT",
      "",
    ].join("\n");

    const load = async (text: string) =>
      new MetaDataLoader().load([new InMemoryStringSource(text, { id: "m.yaml", format: "yaml" })]);

    const before = await load(src);
    expect(before.errors.length).toBeGreaterThan(0);

    const r = rewriteYamlDocument(src);
    expect(r.refusals).toEqual([]);

    const after = await load(r.text);
    expect(after.errors.map((e) => e.message)).toEqual([]);
  });

  test("refuses rather than strand a sequence dash when the retired key leads its item", () => {
    const src = "metadata:\n  children:\n    - requirement.functional:\n        name: R10\n        children:\n          - supersededBy: R1\n";
    const r = rewriteYamlDocument(src);
    // Whatever it decides, it must not produce a bare `-` line.
    expect(r.text).not.toMatch(/^\s*-\s*$/m);
  });
});
