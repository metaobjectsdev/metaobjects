// `attr("isArray")` can only ever return undefined, and undefined is
// indistinguishable from "the author did not set that attribute".
//
// Reserved structural keywords are NATIVE PROPERTIES. `@isArray` is rejected at the
// load with ERR_RESERVED_ATTR, so no document can set one — which means an attribute
// lookup for one is asking a question the metamodel forbids anyone to answer.
//
// This was found in an adopter's own generator: `f.attr("isArray") === true ? base +
// "[]" : base`. The reference document it generated described ALL 31 of that model's
// array fields as scalars. Its sibling module had used the resolving accessor since
// the day it was written, with a comment naming the trap, and nothing compared the
// two. ADR-0039 is taught in three shipped skills and in that file's OWN header,
// fourteen lines above the violation — prose is not a gate.
//
// The set is DERIVED from RESERVED_KEYS, so a keyword added later is covered here
// without anyone remembering this file.

import { describe, test, expect } from "bun:test";
import { MetaField } from "../src/core/field/meta-field.js";
import { MetaObject } from "../src/core/object/meta-object.js";
import { TypeId } from "../src/registry.js";
import { TYPE_FIELD, TYPE_OBJECT } from "../src/shared/base-types.js";
import { RESERVED_KEYS, RESERVED_KEY_VALUE } from "../src/shared/structural.js";

describe("an attr lookup for a reserved structural keyword is refused", () => {
  const node = new MetaField(new TypeId(TYPE_FIELD, "string"), "label");

  test("every reserved keyword except `value` throws on attr() and hasAttr()", () => {
    const guarded = [...RESERVED_KEYS].filter((k) => k !== RESERVED_KEY_VALUE);
    // Proves the derivation reaches real keywords — an empty loop passes vacuously.
    expect(guarded.length).toBeGreaterThan(0);
    for (const key of guarded) {
      expect(() => node.attr(key)).toThrow(/reserved structural keyword/);
      expect(() => node.hasAttr(key)).toThrow(/reserved structural keyword/);
    }
  });

  test("the message names the native accessor to use instead", () => {
    // A refusal that does not say what to do instead just moves the confusion.
    expect(() => node.attr("isArray")).toThrow(/resolvedIsArray\(\)/);
    expect(() => node.attr("children")).toThrow(/children\(\)/);
    const obj = new MetaObject(new TypeId(TYPE_OBJECT, "entity"), "W");
    expect(() => obj.attr("abstract")).toThrow(/isAbstract/);
  });

  test("`value` is NOT refused — an attr node reads its own payload there", () => {
    // The one legitimate reserved-key attr read in the model. Pinned so a tidy-up
    // that folds `value` into the guarded set breaks here rather than in MetaAttr.
    expect(() => node.attr(RESERVED_KEY_VALUE)).not.toThrow();
  });

  test("an ordinary attribute name is untouched", () => {
    expect(() => node.attr("maxLength")).not.toThrow();
  });
});
