// An INT-BACKED field.enum (@intValueMap, design D5) persists as an INTEGER column.
// `like` is a substring match — meaningless against an integer, and it is the one
// operator in the string/enum band that cannot be made to work by encoding the
// member symbol to its integer (eq/ne/in all can, and do).
//
// So the op band is a property of the FIELD, not of the subtype alone: a
// string-backed enum keeps `like`, an int-backed one does not. `opsForSubType`
// cannot express that — it only ever sees "enum". `opsForField` is the field-level
// entry point every op-band consumer must use when it has a field in hand.
//
// Cross-port: fixtures/conformance/filter-ops-matrix pins fEnum vs fEnumInt in all
// five ports, so this narrowing can never become a TS-only divergence.

import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  opsForField,
  opsForSubType,
  FIELD_SUBTYPE_ENUM,
} from "../src/index.js";
import type { MetaField } from "../src/index.js";

async function loadMatrix(): Promise<Map<string, MetaField>> {
  const json = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Matrix",
            children: [
              { "source.rdb": { "@table": "matrix" } },
              { "field.long": { name: "id" } },
              // String-backed enum — the control. Keeps `like`.
              {
                "field.enum": {
                  name: "strEnum",
                  "@values": ["DRAFT", "PUBLISHED"],
                  "@filterable": true,
                },
              },
              // Int-backed enum — declares @intValueMap, so it stores as integer.
              {
                "field.enum": {
                  name: "intEnum",
                  "@values": ["DRAFT", "PUBLISHED"],
                  "@intValueMap": { DRAFT: 0, PUBLISHED: 5 },
                  "@filterable": true,
                },
              },
              { "field.string": { name: "title", "@filterable": true } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
      ],
    },
  });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  const entity = root.objects()[0]!;
  const out = new Map<string, MetaField>();
  for (const f of entity.fields()) out.set(f.name, f);
  return out;
}

describe("opsForField — int-backed enum drops `like`", () => {
  test("a string-backed enum keeps the full string band", async () => {
    const fields = await loadMatrix();
    expect([...opsForField(fields.get("strEnum")!)]).toEqual([
      "eq",
      "ne",
      "in",
      "like",
      "isNull",
    ]);
  });

  test("an int-backed enum drops `like`, keeping eq/ne/in/isNull", async () => {
    const fields = await loadMatrix();
    expect([...opsForField(fields.get("intEnum")!)]).toEqual(["eq", "ne", "in", "isNull"]);
  });

  test("a plain string is untouched by the narrowing", async () => {
    const fields = await loadMatrix();
    expect([...opsForField(fields.get("title")!)]).toEqual(
      [...opsForSubType("string")],
    );
  });

  test("opsForSubType(enum) is unchanged — the narrowing is field-level only", () => {
    // The subtype-keyed band stays the string band. Callers that only have a
    // subtype string (the expression grammar's declared operand type) are
    // deliberately unaffected.
    expect([...opsForSubType(FIELD_SUBTYPE_ENUM)]).toEqual([
      "eq",
      "ne",
      "in",
      "like",
      "isNull",
    ]);
  });

  test("the map is read RESOLVING — an inherited @intValueMap narrows too", async () => {
    // Post-#246 this is the CANONICAL authoring shape: the map lives on the shared
    // root-level abstract declaration and consuming fields inherit it. An own-only
    // read would see undefined here and wrongly keep `like`.
    const json = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "field.enum": {
              name: "SharedStatus",
              abstract: true,
              "@values": ["DRAFT", "PUBLISHED"],
              "@intValueMap": { DRAFT: 0, PUBLISHED: 5 },
            },
          },
          {
            "object.entity": {
              name: "Program",
              children: [
                { "source.rdb": { "@table": "programs" } },
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "status",
                    extends: "acme::SharedStatus",
                    "@filterable": true,
                  },
                },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    });
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    expect(errors).toEqual([]);
    const status = root.objects()[0]!.fields().find((f) => f.name === "status")!;
    expect([...opsForField(status)]).toEqual(["eq", "ne", "in", "isNull"]);
  });
});
