// Derived `has<Field>` accessors — the TS half of a rule the JVM has carried since 7.7.7.
//
// A prompt needs conditional sections, and the payload contract answers that with a
// DERIVED accessor: declare `abilities`, get `hasAbilities`. The JVM emits
// `has<Field>()` onto every generated payload record (SpringPayloadGenerator) and
// accepts `{{#has<Field>}}` in its static drift check (render.Verify), sharing one
// naming rule so the two can never disagree.
//
// TypeScript had NEITHER half, and the consequence was not a loud one. Verify reported
// ERR_VAR_NOT_ON_PAYLOAD for a template the JVM verified clean — and render silently
// produced the WRONG STRING: `{{#hasAbilities}}` resolved to nothing on a populated
// payload, so the section vanished and the prompt shipped without its abilities block.
// An adopter with a JVM-authored prompt estate saw 157 of these, all `has`-prefixed.
//
// The corpus is why it survived: fixtures/render-conformance/ had no case using a
// derived accessor at all, so the gate that exists to keep the ports identical never
// looked at this shape.

import { test, expect, describe } from "bun:test";
import { render } from "../src/render.js";
import { verify } from "../src/verify.js";
import { hasAccessorName, accessorValue, withDerivedAccessors } from "../src/payload-accessors.js";
import type { PayloadField } from "../src/verify.js";

const provider = { resolve: () => undefined };
const r = (template: string, payload: unknown) => render({ template, payload, provider });

describe("the naming rule", () => {
  test("mirrors the JVM: has + capitalize", () => {
    expect(hasAccessorName("abilities")).toBe("hasAbilities");
    expect(hasAccessorName("a")).toBe("hasA");
  });

  test("an already-capitalized first character is left alone", () => {
    expect(hasAccessorName("Abilities")).toBe("hasAbilities");
  });
});

describe("presence semantics mirror the JVM emitter's per-type bodies", () => {
  test("string → non-null and non-blank", () => {
    expect(accessorValue("x")).toBe(true);
    expect(accessorValue("")).toBe(false);
    expect(accessorValue("   ")).toBe(false); // isBlank(), not isEmpty()
  });

  test("array → non-null and non-empty", () => {
    expect(accessorValue([1])).toBe(true);
    expect(accessorValue([])).toBe(false);
  });

  test("reference → non-null", () => {
    expect(accessorValue({})).toBe(true);
    expect(accessorValue(null)).toBe(false);
    expect(accessorValue(undefined)).toBe(false);
  });

  // The JVM emits NO hasFoo for a primitive, so there is nothing to resolve there.
  // Deriving `false` would be worse than deriving nothing: it would make a template
  // that is drift on the JVM render quietly on TS.
  test("numbers and booleans derive NOTHING", () => {
    expect(accessorValue(0)).toBeUndefined();
    expect(accessorValue(42)).toBeUndefined();
    expect(accessorValue(false)).toBeUndefined();
  });
});

describe("render — the bug this fixes", () => {
  const template =
    "Abilities:{{#hasAbilities}}{{#abilities}} [{{name}}]{{/abilities}}{{/hasAbilities}}{{^hasAbilities}} none{{/hasAbilities}}";

  test("a populated collection renders its section (was: silently dropped)", () => {
    expect(r(template, { abilities: [{ name: "Fireball" }] })).toBe("Abilities: [Fireball]");
  });

  test("an empty collection takes the inverted branch", () => {
    expect(r(template, { abilities: [] })).toBe("Abilities: none");
  });

  test("a blank string is absent, matching isBlank()", () => {
    expect(r("{{#hasBio}}{{bio}}{{/hasBio}}{{^hasBio}}-{{/hasBio}}", { bio: "   " })).toBe("-");
  });

  test("accessors are derived inside a nested scope too", () => {
    const t = "{{#items}}{{#hasTags}}<{{#tags}}{{.}}{{/tags}}>{{/hasTags}}{{/items}}";
    expect(r(t, { items: [{ tags: ["a"] }, { tags: [] }] })).toBe("<a>");
  });

  test("an AUTHORED hasFoo wins over the derived one", () => {
    expect(r("{{#hasBio}}yes{{/hasBio}}{{^hasBio}}no{{/hasBio}}", { bio: "x", hasBio: false })).toBe("no");
  });

  test("the caller's payload is never mutated", () => {
    const payload = { abilities: [{ name: "Fireball" }] };
    r(template, payload);
    expect(Object.keys(payload)).toEqual(["abilities"]);
  });
});

describe("verify — accepts exactly what render resolves", () => {
  const fields: PayloadField[] = [
    { name: "abilities", fields: [{ name: "name" }] },
    { name: "bio" },
  ];

  test("a has-section over a declared field is not drift", () => {
    expect(verify("{{#hasAbilities}}{{#abilities}}{{name}}{{/abilities}}{{/hasAbilities}}", fields)).toEqual([]);
  });

  test("an inverted has-section is not drift", () => {
    expect(verify("{{^hasBio}}none{{/hasBio}}", fields)).toEqual([]);
  });

  test("a has-section over a field that does NOT exist is still drift", () => {
    const errs = verify("{{#hasNope}}x{{/hasNope}}", fields);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.path).toBe("hasNope");
  });

  // The body of a has-section is scoped to the SAME context — the gate is a boolean,
  // not a container — so a bad variable inside it must still be caught.
  test("drift inside a has-section body is still reported", () => {
    const errs = verify("{{#hasAbilities}}{{nope}}{{/hasAbilities}}", fields);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.path).toBe("nope");
  });

  test("a dotted path is never treated as an accessor", () => {
    expect(verify("{{abilities.hasName}}", fields)).toHaveLength(1);
  });
});

// ── Regressions caught in review of the original change ──────────────────────
//
// The first draft rebuilt ANY non-array object from Object.entries(), which flattened
// everything carrying its own prototype: a Date stringified to "[object Object]" and a
// class instance lost its getters. Rendering is not allowed to reshape the payload; only
// plain map-shaped values get derived keys, which is also what the other four ports do.
describe("only PLAIN objects are rebuilt", () => {
  test("a Date still renders as a Date", () => {
    const out = r("{{when}}", { when: new Date("2020-01-02T03:04:05Z") });
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("2020");
  });

  test("a class instance keeps its prototype getters", () => {
    class P {
      constructor(public a = 1) {}
      get b(): number {
        return 2;
      }
    }
    expect(r("{{b}}", new P())).toBe("2");
  });

  test("a Date-valued field still derives its accessor", () => {
    expect(r("{{#hasWhen}}Y{{/hasWhen}}", { when: new Date() })).toBe("Y");
  });

  test("plain nested objects still get accessors", () => {
    expect(r("{{#inner}}{{#hasXs}}Y{{/hasXs}}{{/inner}}", { inner: { xs: [1] } })).toBe("Y");
  });
});
