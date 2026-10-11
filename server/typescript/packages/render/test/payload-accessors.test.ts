// Derived `has<Field>` accessors — the TS half of a rule the JVM has carried since 7.7.7.
//
// A prompt needs conditional sections, and the payload contract answers that with a
// DERIVED accessor: declare `abilities`, get `hasAbilities`. The JVM derives
// `has<Field>` for a payload in its render engine (it used to emit `has<Field>()` onto
// every generated payload record, until ADR-0056 removed that copy) and accepts
// `{{#has<Field>}}` in its static drift check (render.Verify), sharing one naming rule
// so the two can never disagree.
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
// class instance lost its getters. Rendering is not allowed to reshape the payload: only
// a plain object is copied, and anything with its own prototype is read through a view.
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

// ── A typed payload renders exactly like the equal plain-object payload ─────────
//
// The oracle is the shared `render-list-separator` fixture: its `expected.txt` is what every
// port must produce from its `payload.json`. Here the SAME data arrives as class instances,
// the shape a caller holds when the payload is built by constructors rather than literals.
// Before the derived accessors reached typed elements, a list of instances rendered a
// trailing separator (`a, b, c, `) because no element carried `-last`.
describe("a typed payload renders like the equal plain-object payload", () => {
  const dir = join(import.meta.dir, "../../../../../fixtures/render-conformance/render-list-separator");
  const template = readFileSync(join(dir, "template.mustache"), "utf8");
  const expected = readFileSync(join(dir, "expected.txt"), "utf8");
  interface Fixture {
    items: { name: string }[];
    solo: { name: string }[];
    none: { name: string }[];
    groups: { tags: { label: string }[] }[];
    entries: { name: string; note?: string; owner: { nick: string } }[];
    authored: { name: string }[];
  }
  const json = JSON.parse(readFileSync(join(dir, "payload.json"), "utf8")) as Fixture;

  class Named {
    constructor(readonly name: string) {}
  }
  class Tag {
    constructor(readonly label: string) {}
  }
  class Group {
    constructor(readonly tags: Tag[]) {}
  }
  // A private field behind a getter: the getter only works when it runs against the
  // instance itself, which is what a view over the instance has to preserve.
  class Owner {
    readonly #nick: string;
    constructor(nick: string) {
      this.#nick = nick;
    }
    get nick(): string {
      return this.#nick;
    }
  }
  class Entry {
    constructor(
      readonly name: string,
      readonly owner: Owner,
      readonly note?: string,
    ) {}
  }
  // An AUTHORED `-last` member: it must win over the derived position.
  class Pinned {
    readonly "-last" = true;
    constructor(readonly name: string) {}
  }
  class Payload {
    readonly items = json.items.map((i) => new Named(i.name));
    readonly solo = json.solo.map((i) => new Named(i.name));
    readonly none = json.none.map((i) => new Named(i.name));
    readonly groups = json.groups.map((g) => new Group(g.tags.map((t) => new Tag(t.label))));
    readonly entries = json.entries.map((e) => new Entry(e.name, new Owner(e.owner.nick), e.note));
    readonly authored = json.authored.map((a) => new Pinned(a.name));
  }

  test("the list-separator fixture renders its expected output from class instances", () => {
    expect(r(template, json)).toBe(expected);
    expect(r(template, new Payload())).toBe(expected);
  });

  test("a frozen typed payload renders the same", () => {
    const frozen = Object.freeze(new Payload());
    for (const item of frozen.items) Object.freeze(item);
    expect(r(template, frozen)).toBe(expected);
  });

  test("has<Field> is derived for a class instance exactly as for the equal plain object", () => {
    class Hero {
      readonly abilities = ["fly"];
      readonly bio = "  ";
      readonly level = 3;
      get nickname(): string {
        return "Ace";
      }
    }
    const tpl =
      "{{#hasAbilities}}A{{/hasAbilities}}{{^hasBio}}no-bio{{/hasBio}}{{#hasNickname}}N{{/hasNickname}}" +
      "[{{#hasLevel}}L{{/hasLevel}}]";
    const plain = { abilities: ["fly"], bio: "  ", level: 3, nickname: "Ace" };
    expect(r(tpl, plain)).toBe("Ano-bioN[]");
    expect(r(tpl, new Hero())).toBe(r(tpl, plain));
  });

  test("an authored has<Field> member wins on a class instance", () => {
    class Quiet {
      readonly abilities = ["fly"];
      readonly hasAbilities = false;
    }
    expect(r("{{#hasAbilities}}A{{/hasAbilities}}{{^hasAbilities}}none{{/hasAbilities}}", new Quiet())).toBe("none");
  });

  test("a value nested in a class instance keeps its own string form", () => {
    class Stamped {
      readonly when = new Date("2020-01-02T03:04:05Z");
    }
    expect(r("{{when}}", new Stamped())).toBe(r("{{when}}", { when: new Date("2020-01-02T03:04:05Z") }));
  });

  test("a method on a class instance still resolves as a computed value", () => {
    class Person {
      constructor(
        readonly first: string,
        readonly last: string,
      ) {}
      full(): string {
        return `${this.first} ${this.last}`;
      }
    }
    expect(r("{{full}}", new Person("Ada", "Lovelace"))).toBe("Ada Lovelace");
  });

  // The count is what proves laziness: a view that read every member up front and swallowed
  // the failure would still render "a,b".
  test("a member the template never names is never read", () => {
    let reads = 0;
    class Line {
      constructor(readonly sku: string) {}
      get exploding(): string {
        reads += 1;
        throw new Error("read a member the template never names");
      }
    }
    class Order {
      readonly lines = [new Line("a"), new Line("b")];
    }
    expect(r("{{#lines}}{{sku}}{{^-last}},{{/-last}}{{/lines}}", new Order())).toBe("a,b");
    expect(reads).toBe(0);
  });
});
