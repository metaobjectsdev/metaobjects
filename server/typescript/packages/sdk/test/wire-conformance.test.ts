// ADR-0019 Amendment 2 — the cross-port `wire` setting, run through TypeScript's own config
// reader: every valid block resolves to the corpus's values, every invalid one is refused when
// the config is read, and the project-aware load sets the root.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_WIRE_FORMAT, wireFormatOf, type WireDecimals, type WireNullMembers } from "@metaobjectsdev/metadata";
import { ConfigSchema, wireFormatFromConfig } from "../src/config.js";
import { loadMemory } from "../src/memory.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/wire-conformance/config-blocks.json");

interface WireCase { name: string; wire: unknown; decimals: WireDecimals; nullMembers: WireNullMembers }
const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as {
  cases: WireCase[];
  invalid: { name: string; wire: unknown }[];
};

/** The config file a project would carry for this case. */
function configFor(wire: unknown): Record<string, unknown> {
  return wire === null ? { schema_version: 1 } : { schema_version: 1, wire };
}

const MODEL = { "metadata.root": { package: "w", children: [
  { "object.entity": { name: "Thing", children: [{ "field.string": { name: "id" } }] } },
] } };

describe("wire conformance (ADR-0019 Amendment 2)", () => {
  for (const c of corpus.cases) {
    test(`${c.name}: resolves to decimals=${c.decimals} nullMembers=${c.nullMembers}`, () => {
      const wire = wireFormatFromConfig(ConfigSchema.parse(configFor(c.wire)));
      expect(wire).toEqual({ decimals: c.decimals, nullMembers: c.nullMembers });
    });
  }

  for (const c of corpus.invalid) {
    test(`${c.name}: the config is refused when read`, () => {
      expect(ConfigSchema.safeParse(configFor(c.wire)).success).toBe(false);
    });
  }

  test("the refusal names the key and the allowed values", () => {
    const r = ConfigSchema.safeParse(configFor({ decimals: "number" }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('\\"wire.decimals\\" must be one of \\"native\\", \\"string\\"');
  });

  test("an unknown key and a non-object block are refused by name", () => {
    const unknown = ConfigSchema.safeParse(configFor({ dates: "iso" }));
    expect(unknown.error?.issues.map((i) => i.message)).toContain(
      '"wire" has an unknown key "dates" (expected "decimals" and/or "nullMembers")');
    const scalar = ConfigSchema.safeParse(configFor("string"));
    expect(scalar.error?.issues.map((i) => i.message)).toContain('"wire" must be an object');
  });

  test("the project-aware load sets the root from .metaobjects/config.json", async () => {
    const portable = corpus.cases.find((c) => c.name.startsWith("portable form"))!;
    const dir = mkdtempSync(join(tmpdir(), "mo-wire-"));
    try {
      mkdirSync(join(dir, ".metaobjects"));
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, ".metaobjects", "config.json"), JSON.stringify(configFor(portable.wire)));
      writeFileSync(join(dir, "metaobjects", "meta.w.json"), JSON.stringify(MODEL));
      const root = await loadMemory(dir);
      expect(root.wireFormat).toEqual({ decimals: "string", nullMembers: "omit" });
      expect(wireFormatOf(root.findObject("Thing")!)).toEqual({ decimals: "string", nullMembers: "omit" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a project with no wire block loads with the native defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mo-wire-"));
    try {
      mkdirSync(join(dir, ".metaobjects"));
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, ".metaobjects", "config.json"), JSON.stringify(configFor(null)));
      writeFileSync(join(dir, "metaobjects", "meta.w.json"), JSON.stringify(MODEL));
      const root = await loadMemory(dir);
      expect(root.wireFormat).toEqual(DEFAULT_WIRE_FORMAT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
