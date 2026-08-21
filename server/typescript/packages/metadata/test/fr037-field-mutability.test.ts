// FR-037 R1 — the field-level @mutability enum. Tests the metamodel surface:
// constant exports, schema registration, the five validation rules
// (ERR_MUTABILITY_AUTOSET_CONFLICT, ERR_MUTABILITY_DOWNGRADE,
// ERR_READONLY_ASSIGNED_PRIMARY, WARN_MUTABILITY_VALUE_OBJECT,
// WARN_MUTABILITY_READONLY_HOST), and the resolving `fieldMutability` accessor
// that codegen / runtime consume.
//
// Replaces fr013-field-readonly.test.ts. `@readOnly` was a BOOLEAN; the cut to an
// enum is what makes readOnly-and-writeOnce unrepresentable and gives inheritance
// a total order, so several cases here have no boolean-era counterpart.

import { describe, expect, test } from "bun:test";
import {
  FIELD_ATTR_MUTABILITY,
  MUTABILITY_READ_WRITE,
  MUTABILITY_WRITE_ONCE,
  MUTABILITY_READ_ONLY,
  MUTABILITY_MODES,
} from "../src/core/field/field-constants.js";
import { fieldMutability, isReadOnlyMutability, isWriteOnceMutability } from "../src/index.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { ERROR_CODES, WARNING_CODES } from "../src/errors.js";
import { TYPE_OBJECT, TYPE_FIELD } from "../src/shared/base-types.js";

async function load(doc: unknown, opts?: { strict?: boolean }) {
  const loader = new MetaDataLoader(opts);
  return loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
}

const codesOf = (errors: readonly unknown[]) =>
  errors.map((e) => (e as { code: string }).code);

/** One entity with `fields` spliced in, plus a writable source and a PK. */
function entity(name: string, fields: unknown[], extra: unknown[] = []) {
  return {
    "object.entity": {
      name,
      children: [
        { "source.rdb": { "@table": name.toLowerCase() } },
        { "field.long": { name: "id" } },
        ...fields,
        { "identity.primary": { name: "id", "@fields": "id" } },
        ...extra,
      ],
    },
  };
}

const doc = (children: unknown[]) => ({ "metadata.root": { package: "demo", children } });

describe("FR-037 R1 constants + error/warning code registration", () => {
  test("FIELD_ATTR_MUTABILITY exported as 'mutability'", () => {
    expect(FIELD_ATTR_MUTABILITY).toBe("mutability");
  });

  test("the three modes are exported with their wire values", () => {
    expect(MUTABILITY_READ_WRITE).toBe("readWrite");
    expect(MUTABILITY_WRITE_ONCE).toBe("writeOnce");
    expect(MUTABILITY_READ_ONLY).toBe("readOnly");
  });

  test("MUTABILITY_MODES declaration order IS the tightening order", () => {
    // Load-bearing: the downgrade rule is an INDEX comparison over this array, so
    // reordering it silently inverts the rule. Pinned rather than commented.
    expect([...MUTABILITY_MODES]).toEqual(["readWrite", "writeOnce", "readOnly"]);
  });

  test("the new codes are registered", () => {
    expect(ERROR_CODES).toContain("ERR_MUTABILITY_AUTOSET_CONFLICT");
    expect(ERROR_CODES).toContain("ERR_MUTABILITY_DOWNGRADE");
    expect(ERROR_CODES).toContain("ERR_READONLY_ASSIGNED_PRIMARY");
    expect(WARNING_CODES).toContain("WARN_MUTABILITY_VALUE_OBJECT");
    expect(WARNING_CODES).toContain("WARN_MUTABILITY_READONLY_HOST");
  });

  test("the retired boolean-era codes are GONE from the ledger", () => {
    // ERR_MUTABILITY_DOWNGRADE replaces ERR_READONLY_DOWNGRADE because the rule
    // now spans three modes — a code named READONLY would misdescribe a
    // writeOnce → readWrite loosening.
    expect(ERROR_CODES).not.toContain("ERR_READONLY_DOWNGRADE");
    expect(WARNING_CODES).not.toContain("WARN_READONLY_VALUE_OBJECT");
  });
});

describe("FR-037 R1 schema registration + the legacy attr", () => {
  test("a writable entity accepts each of the three modes", async () => {
    for (const mode of MUTABILITY_MODES) {
      const { errors } = await load(doc([
        entity("Customer", [
          { "field.string": { name: "label", "@mutability": mode } },
        ]),
      ]));
      expect(codesOf(errors)).toEqual([]);
    }
  });

  test("an unknown mode fails the LOAD — allowedValues, not a codegen-time check", async () => {
    const { errors } = await load(doc([
      entity("Customer", [
        { "field.string": { name: "label", "@mutability": "readonly" } },
      ]),
    ]));
    // Note the lowercase 'o' — the near-miss an author actually types.
    expect(codesOf(errors)).toContain("ERR_BAD_ATTR_VALUE");
  });

  test("a legacy @readOnly fails a STRICT load — ERR_UNKNOWN_ATTR, no deprecation shim", async () => {
    // ADR-0023: this repo's corpora and `meta verify` load strict, so a retired
    // attr is a hard failure there. The public LoadOptions.strict default stays
    // false so a downstream app can loosen — which is why this passes `strict`
    // explicitly rather than relying on the constructor default.
    const { errors } = await load(doc([
      entity("Customer", [
        { "field.timestamp": { name: "createdAt", "@readOnly": true } },
      ]),
    ]), { strict: true });
    expect(codesOf(errors)).toContain("ERR_UNKNOWN_ATTR");
  });
});

describe("FR-037 R1 fieldMutability accessor", () => {
  async function modeOf(fieldDecl: unknown, name: string) {
    const { root, errors } = await load(doc([entity("Customer", [fieldDecl])]));
    expect(codesOf(errors)).toEqual([]);
    const obj = root.children().find((c) => c.type === TYPE_OBJECT)!;
    return obj.children().find((c) => c.type === TYPE_FIELD && c.name === name)!;
  }

  test("absent ⇒ readWrite (the default lives in ONE place per port)", async () => {
    const f = await modeOf({ "field.string": { name: "label" } }, "label");
    expect(fieldMutability(f)).toBe("readWrite");
    expect(isReadOnlyMutability(f)).toBe(false);
    expect(isWriteOnceMutability(f)).toBe(false);
  });

  test("declared modes read back, and the two predicates agree", async () => {
    const ro = await modeOf({ "field.string": { name: "label", "@mutability": "readOnly" } }, "label");
    expect(fieldMutability(ro)).toBe("readOnly");
    expect(isReadOnlyMutability(ro)).toBe(true);
    expect(isWriteOnceMutability(ro)).toBe(false);

    const wo = await modeOf({ "field.string": { name: "label", "@mutability": "writeOnce" } }, "label");
    expect(fieldMutability(wo)).toBe("writeOnce");
    expect(isWriteOnceMutability(wo)).toBe(true);
    expect(isReadOnlyMutability(wo)).toBe(false);
  });

  test("RESOLVING, not own — a mode inherited via extends is visible (ADR-0039)", async () => {
    // The bug class ADR-0039 exists for: an own-only read here would report
    // readWrite for a field the parent declared readOnly, and codegen would emit
    // a setter for a column nothing may write.
    const { root, errors } = await load(doc([
      { "object.entity": { name: "BaseEntity", abstract: true, children: [
        { "field.timestamp": { name: "createdAt", "@mutability": "readOnly" } },
      ] } },
      { "object.entity": { name: "Subscriber", extends: "BaseEntity", children: [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
    ]));
    expect(codesOf(errors)).toEqual([]);
    const sub = root.children().find((c) => c.type === TYPE_OBJECT && c.name === "Subscriber")!;
    const created = sub.children().find((c) => c.type === TYPE_FIELD && c.name === "createdAt")!;
    expect(fieldMutability(created)).toBe("readOnly");
  });
});

describe("FR-037 R1 ERR_MUTABILITY_AUTOSET_CONFLICT", () => {
  // The boolean era left readOnly × @autoSet REPRESENTABLE but unvalidated. The
  // enum cut closes both arms with one rule.
  test("@autoSet with readOnly errors", async () => {
    const { errors } = await load(doc([
      entity("Customer", [
        { "field.timestamp": { name: "createdAt", "@autoSet": "onCreate", "@mutability": "readOnly" } },
      ]),
    ]));
    expect(codesOf(errors)).toContain("ERR_MUTABILITY_AUTOSET_CONFLICT");
  });

  test("@autoSet with writeOnce errors", async () => {
    const { errors } = await load(doc([
      entity("Customer", [
        { "field.timestamp": { name: "createdAt", "@autoSet": "onCreate", "@mutability": "writeOnce" } },
      ]),
    ]));
    expect(codesOf(errors)).toContain("ERR_MUTABILITY_AUTOSET_CONFLICT");
  });

  test("@autoSet alone is fine — the conflict is with the OTHER axis, not @autoSet", async () => {
    const { errors } = await load(doc([
      entity("Customer", [
        { "field.timestamp": { name: "createdAt", "@autoSet": "onCreate" } },
      ]),
    ]));
    expect(codesOf(errors)).not.toContain("ERR_MUTABILITY_AUTOSET_CONFLICT");
  });

  test("@autoSet with an EXPLICIT readWrite is fine — it restates the default", async () => {
    const { errors } = await load(doc([
      entity("Customer", [
        { "field.timestamp": { name: "createdAt", "@autoSet": "onUpdate", "@mutability": "readWrite" } },
      ]),
    ]));
    expect(codesOf(errors)).not.toContain("ERR_MUTABILITY_AUTOSET_CONFLICT");
  });

  test("the conflict fires on an INHERITED mode too — coherence is a property of the effective tree", async () => {
    const { errors } = await load(doc([
      { "object.entity": { name: "BaseEntity", abstract: true, children: [
        { "field.timestamp": { name: "createdAt", "@mutability": "readOnly" } },
      ] } },
      { "object.entity": { name: "Subscriber", extends: "BaseEntity", children: [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long": { name: "id" } },
        { "field.timestamp": { name: "createdAt", "@autoSet": "onCreate", "@mutability": "readOnly" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
    ]));
    expect(codesOf(errors)).toContain("ERR_MUTABILITY_AUTOSET_CONFLICT");
  });
});

describe("FR-037 R1 ERR_MUTABILITY_DOWNGRADE (extends inheritance)", () => {
  async function pair(baseMode: string, subMode: string) {
    return load(doc([
      { "object.entity": { name: "BaseEntity", abstract: true, children: [
        { "field.string": { name: "label", "@mutability": baseMode } },
      ] } },
      { "object.entity": { name: "Subscriber", extends: "BaseEntity", children: [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "label", "@mutability": subMode } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
    ]));
  }

  test("every LOOSENING pair errors", async () => {
    for (const [base, sub] of [
      ["readOnly", "writeOnce"],
      ["readOnly", "readWrite"],
      ["writeOnce", "readWrite"],
    ] as const) {
      const { errors } = await pair(base, sub);
      expect(codesOf(errors)).toContain("ERR_MUTABILITY_DOWNGRADE");
    }
  });

  test("every TIGHTENING pair is fine", async () => {
    for (const [base, sub] of [
      ["readWrite", "writeOnce"],
      ["readWrite", "readOnly"],
      ["writeOnce", "readOnly"],
    ] as const) {
      const { errors } = await pair(base, sub);
      expect(codesOf(errors)).not.toContain("ERR_MUTABILITY_DOWNGRADE");
    }
  });

  test("restating the SAME mode is fine", async () => {
    for (const mode of MUTABILITY_MODES) {
      const { errors } = await pair(mode, mode);
      expect(codesOf(errors)).not.toContain("ERR_MUTABILITY_DOWNGRADE");
    }
  });

  test("a subtype declaring NOTHING inherits without complaint", async () => {
    const { errors } = await load(doc([
      { "object.entity": { name: "BaseEntity", abstract: true, children: [
        { "field.string": { name: "label", "@mutability": "readOnly" } },
      ] } },
      { "object.entity": { name: "Subscriber", extends: "BaseEntity", children: [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
    ]));
    expect(codesOf(errors)).not.toContain("ERR_MUTABILITY_DOWNGRADE");
  });
});

describe("FR-037 R1 ERR_READONLY_ASSIGNED_PRIMARY (keeps its readOnly-specific name)", () => {
  function assignedKey(mode?: string) {
    const attrs = mode === undefined ? {} : { "@mutability": mode };
    return doc([
      { "object.entity": { name: "Ledger", children: [
        { "source.rdb": { "@table": "ledger" } },
        { "field.string": { name: "id", ...attrs } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "assigned" } },
      ] } },
    ]);
  }

  test("readOnly on an ASSIGNED primary key errors — nothing could ever populate it", async () => {
    const { errors } = await load(assignedKey("readOnly"));
    expect(codesOf(errors)).toContain("ERR_READONLY_ASSIGNED_PRIMARY");
  });

  test("writeOnce on an assigned primary key is LEGAL — and is the natural declaration", async () => {
    // THE asymmetry that justifies the enum: "set once on create, never changed"
    // is exactly what an assigned key wants, and the boolean vocabulary could not
    // say it — @readOnly:true was the only non-default, and it is wrong here.
    const { errors } = await load(assignedKey("writeOnce"));
    expect(codesOf(errors)).toEqual([]);
  });

  test("readOnly on a GENERATED primary key is fine — the DB populates it", async () => {
    const { errors } = await load(doc([
      { "object.entity": { name: "Subscriber", children: [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long": { name: "id", "@mutability": "readOnly" } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
      ] } },
    ]));
    expect(codesOf(errors)).not.toContain("ERR_READONLY_ASSIGNED_PRIMARY");
  });
});

describe("FR-037 R1 WARN_MUTABILITY_VALUE_OBJECT", () => {
  async function valueWith(mode: string) {
    return load(doc([
      { "object.value": { name: "Money", children: [
        { "field.long": { name: "amountCents", "@mutability": mode } },
        { "field.string": { name: "currency" } },
      ] } },
      { "object.entity": { name: "Item", children: [
        { "source.rdb": { "@table": "items" } },
        { "field.long": { name: "id" } },
        { "field.object": { name: "price", "@objectRef": "Money", "@storage": "flattened" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
    ]));
  }

  test("a non-default mode on a value's field warns (advisory, not an error)", async () => {
    for (const mode of ["readOnly", "writeOnce"]) {
      const { warnings, errors } = await valueWith(mode);
      expect(warnings.map((w) => w.code)).toContain("WARN_MUTABILITY_VALUE_OBJECT");
      expect(codesOf(errors)).toEqual([]);
    }
  });

  test("an explicit readWrite on a value does NOT warn — it asserts the default", async () => {
    const { warnings } = await valueWith("readWrite");
    expect(warnings.map((w) => w.code)).not.toContain("WARN_MUTABILITY_VALUE_OBJECT");
  });
});

describe("FR-037 R1 WARN_MUTABILITY_READONLY_HOST", () => {
  test("writeOnce on a projection warns — the declaration is inert, not wrong", async () => {
    const { warnings, errors } = await load(doc([
      { "object.entity": { name: "Program", children: [
        { "source.rdb": { "@table": "programs" } },
        { "field.uuid": { name: "id" } },
        { "field.string": { name: "title" } },
        { "identity.primary": { name: "id", "@fields": ["id"] } },
      ] } },
      { "object.projection": { name: "ProgramSummary", children: [
        { "source.rdb": { "@kind": "view", "@view": "v_program_summary" } },
        { "field.uuid": { name: "id", extends: "demo::Program.id" } },
        { "field.string": { name: "title", extends: "demo::Program.title",
                            "@mutability": "writeOnce" } },
        { "identity.primary": { name: "id", extends: "demo::Program.id" } },
      ] } },
    ]));
    expect(codesOf(errors)).toEqual([]);
    expect(warnings.map((w) => w.code)).toContain("WARN_MUTABILITY_READONLY_HOST");
  });

  test("writeOnce on a normal writable entity does NOT warn", async () => {
    const { warnings } = await load(doc([
      entity("Customer", [
        { "field.string": { name: "label", "@mutability": "writeOnce" } },
      ]),
    ]));
    expect(warnings.map((w) => w.code)).not.toContain("WARN_MUTABILITY_READONLY_HOST");
  });
});
