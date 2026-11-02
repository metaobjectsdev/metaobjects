// The cross-port enum-length corpus, run through TypeScript's own config reader and
// resolver: the `enums` block parses with the schema `.metaobjects/config.json` is read with,
// the loaded root carries it, and every enum's column length resolves through
// resolveEnumMaxLength, the function `meta migrate` and the generated bindings call.

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { MetaDataLoader, MetaModelError, isMetaRoot, resolveEnumMaxLength, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { ConfigSchema, enumDefaultsFromConfig } from "../src/config.js";
import { loadMemory } from "../src/memory.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/enum-length-conformance");

interface Case { name: string; enums: unknown; lengths: Record<string, number | null> }
interface Overflow { name: string; enums: unknown; field: string; member: string }
const corpus = JSON.parse(readFileSync(join(CORPUS, "cases.json"), "utf8")) as {
  cases: Case[];
  overflow: Overflow[];
  invalid: { name: string; enums: unknown }[];
};

const configFor = (enums: unknown): Record<string, unknown> =>
  enums === null ? { schema_version: 1 } : { schema_version: 1, enums };

async function loadCorpusModel(enums: unknown): Promise<MetaRoot> {
  const result = await new MetaDataLoader().load([new FileSource(join(CORPUS, "meta.enums.json"))]);
  expect(result.errors).toEqual([]);
  if (!isMetaRoot(result.root)) throw new Error("not a root");
  result.root.enumDefaults = enumDefaultsFromConfig(ConfigSchema.parse(configFor(enums)));
  return result.root;
}

const ticketField = (root: MetaRoot, name: string) =>
  (root.findObject("Ticket") as MetaObject).fields().find((f) => f.name === name)!;

describe("enum-length conformance", () => {
  for (const c of corpus.cases) {
    test(`${c.name}: every enum's column length`, async () => {
      const root = await loadCorpusModel(c.enums);
      const actual: Record<string, number | null> = {};
      for (const name of Object.keys(c.lengths)) actual[name] = resolveEnumMaxLength(ticketField(root, name)) ?? null;
      expect(actual).toEqual(c.lengths);
    });
  }

  for (const o of corpus.overflow) {
    test(`${o.name}: refused, naming the member`, async () => {
      const root = await loadCorpusModel(o.enums);
      let caught: unknown;
      try { resolveEnumMaxLength(ticketField(root, o.field)); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(MetaModelError);
      expect((caught as MetaModelError).code).toBe("ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH");
      expect((caught as Error).message).toContain(o.member);
    });
  }

  for (const c of corpus.invalid) {
    test(`${c.name}: the config is refused when read`, () => {
      expect(ConfigSchema.safeParse(configFor(c.enums)).success).toBe(false);
    });
  }

  test("the project-aware load sets the root from .metaobjects/config.json", async () => {
    const withDefault = corpus.cases.find((c) => c.enums !== null && Object.keys(c.enums as object).length > 0)!;
    const dir = mkdtempSync(join(tmpdir(), "mo-enums-"));
    try {
      mkdirSync(join(dir, ".metaobjects"));
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, ".metaobjects", "config.json"), JSON.stringify(configFor(withDefault.enums)));
      copyFileSync(join(CORPUS, "meta.enums.json"), join(dir, "metaobjects", "meta.enums.json"));
      const root = await loadMemory(dir);
      expect(root.enumDefaults).toEqual(withDefault.enums as object);
      expect(resolveEnumMaxLength(ticketField(root, "status")) ?? null).toBe(withDefault.lengths.status ?? null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
