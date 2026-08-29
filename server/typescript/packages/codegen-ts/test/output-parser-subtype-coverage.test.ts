// A5 — the strict response parser must validate every field subtype it is handed.
//
// `SCALAR_ZOD` held nine entries and everything else fell through `?? "z.unknown()"`, so a
// declared response payload of eleven field subtypes validated THREE of them. `z.unknown()`
// accepts anything, including `null` on a `@required` field. The map even carried `class`,
// `short` and `byte` — the three subtypes this project cut as non-functional
// registration-only stubs — while missing `currency` and `uuid`.
//
// The inversion is what made it serious: validation was strongest on the payload we control
// and absent on the reply we do not, in the tier whose whole name is parser-on-receipt. And
// it was an internal contradiction rather than a missing capability — the tolerant
// extractor in the SAME generated file reads live metadata and rejects a non-member, as does
// Python's `FieldSpec.enum_field`. Only this strict path — the one called `parse<Name>`,
// documented `@throws on validation failure`, and the first one an adopter reaches for —
// threw the domain away.
//
// Found by declaring a prompt in a from-scratch app and executing the generated parser
// against three malformed replies; all three were accepted.
//
// Why nothing here caught it: every existing parser test asserts on a payload of strings,
// ints and enums-via-the-TOLERANT-path, and none ever asserted the absence of `z.unknown()`.
// A schema full of `z.unknown()` parses every fixture perfectly.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderOutputParser } from "../src/templates/output-parser.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme::ai", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

/** One response field per persistable subtype the parser is expected to know. */
const WIDE = [
  {
    "object.value": {
      name: "Payload",
      children: [{ "field.string": { name: "q", "@required": true } }],
    },
  },
  {
    "object.value": {
      name: "Wide",
      children: [
        { "field.string": { name: "s", "@required": true } },
        { "field.int": { name: "i", "@required": true } },
        { "field.long": { name: "l", "@required": true } },
        { "field.double": { name: "dbl", "@required": true } },
        { "field.boolean": { name: "b", "@required": true } },
        { "field.enum": { name: "e", "@values": ["A", "B"], "@required": true } },
        { "field.uuid": { name: "u", "@required": true } },
        { "field.date": { name: "d", "@required": true } },
        { "field.time": { name: "t", "@required": true } },
        { "field.timestamp": { name: "ts", "@required": true } },
        { "field.decimal": { name: "dec", "@required": true } },
        { "field.currency": { name: "cur", "@required": true, "@currency": "USD" } },
        { "field.uri": { name: "url", "@required": true } },
        { "field.inet": { name: "ip", "@required": true } },
      ],
    },
  },
  {
    "template.prompt": {
      name: "WideOut",
      "@payloadRef": "Payload",
      "@textRef": "t/x",
      "@responseRef": "Wide",
    },
  },
];

describe("A5 — strict response parser subtype coverage", () => {
  test("no declared subtype degrades to z.unknown()", async () => {
    const src = renderOutputParser(await loadRoot(WIDE), "WideOut");
    const schema = /const WideOutSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(src)?.[1] ?? "";
    expect(schema).not.toBe("");
    // The whole failure was silent permissiveness, so assert on its absence directly.
    expect(schema).not.toContain("z.unknown()");
  });

  test("each subtype maps to the wire shape the rest of the toolchain uses", async () => {
    const src = renderOutputParser(await loadRoot(WIDE), "WideOut");
    // Enum carries its declared members — the one closed domain in an untrusted reply.
    expect(src).toContain(`e: z.enum(["A", "B"])`);
    expect(src).toContain("u: z.string().uuid()");
    // Currency is integer minor units on the wire in every port; never a float.
    expect(src).toContain("cur: z.number().int()");
    // A decimal crosses as a STRING so it does not become a float — accepting a number
    // would re-admit exactly the loss `field.decimal` exists to prevent.
    expect(src).toContain("dec: z.string()");
    // Temporal values are ISO strings in raw JSON, the same reasoning zod-validators.ts
    // records for z.coerce.date().
    expect(src).toContain("ts: z.string()");
  });

  test("an enum inheriting its @values through extends still resolves (ADR-0039 resolving)", async () => {
    const src = renderOutputParser(
      await loadRoot([
        { "field.enum": { name: "priority", abstract: true, "@values": ["LOW", "HIGH"] } },
        {
          "object.value": {
            name: "P",
            children: [{ "field.string": { name: "q", "@required": true } }],
          },
        },
        {
          "object.value": {
            name: "V",
            children: [{ "field.enum": { name: "p", extends: "priority", "@required": true } }],
          },
        },
        {
          "template.prompt": {
            name: "InheritOut",
            "@payloadRef": "P",
            "@textRef": "t/x",
            "@responseRef": "V",
          },
        },
      ]),
      "InheritOut",
    );
    expect(src).toContain(`p: z.enum(["LOW", "HIGH"])`);
  });

  test("EXECUTED: the generated parser rejects a non-member, a number, and null", async () => {
    const src = renderOutputParser(await loadRoot(WIDE), "WideOut");
    // Rebuild just the schema in-process rather than writing/importing a file: the point
    // is the emitted expression's runtime behaviour, and asserting on text alone is what
    // let `z.unknown()` sit here.
    const schemaExpr = /const WideOutSchema = (z\.object\(\{[\s\S]*?\n\}\));/.exec(src)?.[1];
    expect(schemaExpr).toBeDefined();
    const { z } = await import("zod");
    const schema = new Function("z", `return ${schemaExpr};`)(z) as {
      safeParse: (v: unknown) => { success: boolean };
    };

    const ok = {
      s: "x", i: 1, l: 2, dbl: 1.5, b: true, e: "A",
      u: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      d: "2026-01-01", t: "10:00:00", ts: "2026-01-01T10:00:00Z",
      dec: "1.25", cur: 199, url: "https://example.test", ip: "10.0.0.1",
    };
    expect(schema.safeParse(ok).success).toBe(true);

    // The three replies that were accepted before the fix.
    expect(schema.safeParse({ ...ok, e: "CRITICAL" }).success).toBe(false);
    expect(schema.safeParse({ ...ok, e: 7 }).success).toBe(false);
    expect(schema.safeParse({ ...ok, e: null }).success).toBe(false);
    // And a float where integer minor units are required.
    expect(schema.safeParse({ ...ok, cur: 1.99 }).success).toBe(false);
  });
});
