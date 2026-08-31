// ADR-0034 verification: the copyable reference templates (src/reference/*.ts) must
// produce BYTE-IDENTICAL output to the built-in generators they were relocated from.
// The reference generators import only "@metaobjectsdev/codegen-ts" (the public engine);
// if this passes, a consumer can copy them out and own them with no behavior change.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig, REFERENCE_GENERATOR_NAMES } from "../src/index.js";
import type { ReferenceGeneratorName, Generator } from "../src/index.js";
import {
  entityFile as builtinEntity,
  queriesFile as builtinQueries,
  routesFile as builtinRoutes,
  routesFileHono as builtinRoutesHono,
  barrel as builtinBarrel,
  namesFile as builtinNames,
} from "../src/generators/index.js";
import { entityFile as refEntity } from "../src/reference/entity.js";
import { queriesFile as refQueries } from "../src/reference/queries.js";
import { routesFile as refRoutes } from "../src/reference/routes.js";
import { routesFileHono as refRoutesHono } from "../src/reference/routes-hono.js";
import { barrel as refBarrel } from "../src/reference/barrel.js";
import { namesFile as refNames } from "../src/reference/names.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE_DIR = resolve(import.meta.dir, "fixtures");
const FIXTURES = [
  "single-entity.json",
  "two-entities-fk.json",
  "cross-package-vo.json",
  "trainer-website-shape.json",
  "packaged-shape.json",
];

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-ref-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function gen(dir: string, generators: ReturnType<typeof builtinEntity>[], root: Parameters<typeof runGen>[0]["metadata"]) {
  await runGen({
    config: defineConfig({ outDir: dir, extStyle: "none", dbImport: "~/server/db", dialect: "sqlite", generators }),
    metadata: root,
  });
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) out[f] = readFileSync(join(dir, f), "utf-8");
  return out;
}

// Per ejectable name, the pair this file runs. Keyed by name and typed as a Record over
// the name union, so coverage is STRUCTURAL rather than a parallel list asserted equal:
// adding a template to REFERENCE_GENERATOR_NAMES makes this object fail to COMPILE until
// its pair is supplied, and the pair IS the wiring. A hand-maintained `COVERED` array
// could be satisfied by editing one line without adding any verification — proving the
// list was touched, not that the generator was tested.
const PAIRS: Record<ReferenceGeneratorName, { builtin: () => Generator; ref: () => Generator }> = {
  entity: { builtin: builtinEntity, ref: refEntity },
  queries: { builtin: builtinQueries, ref: refQueries },
  routes: { builtin: builtinRoutes, ref: refRoutes },
  "routes-hono": { builtin: builtinRoutesHono, ref: refRoutesHono },
  barrel: { builtin: builtinBarrel, ref: refBarrel },
  names: { builtin: builtinNames, ref: refNames },
};

describe("ADR-0034 — reference templates are byte-identical to built-ins", () => {
  // The gate has to notice its own coverage shrinking. FR-040 added `routes-hono`
  // here and four more across the UI packages, and every one of them shipped
  // unverified because nothing required this list to stay complete.
  test("every ejectable template in this package is covered", () => {
    expect(Object.keys(PAIRS).sort()).toEqual([...REFERENCE_GENERATOR_NAMES].sort());
  });

  for (const fixture of FIXTURES) {
    test(fixture, async () => {
      const loader = new MetaDataLoader();
      const result = await loader.load([new FileSource(join(FIXTURE_DIR, fixture))]);
      expect(result.errors).toEqual([]);

      const aDir = mkdtempSync(join(tmpdir(), "codegen-builtin-"));
      const bDir = mkdtempSync(join(tmpdir(), "codegen-reference-"));
      try {
        // routes-hono emits `<Entity>.routes.hono.ts`, so it does not collide with
        // routesFile()'s `<Entity>.routes.ts` and both ride the same run.
        const a = await gen(aDir, Object.values(PAIRS).map((p) => p.builtin()), result.root);
        const b = await gen(bDir, Object.values(PAIRS).map((p) => p.ref()), result.root);
        const aKeys = Object.keys(a).sort();
        const bKeys = Object.keys(b).sort();
        // same set of files
        expect(bKeys).toEqual(aKeys);
        // byte-identical contents for every file both sides agree on emitting
        for (const k of aKeys) {
          expect(`${k}:\n${b[k]}`).toBe(`${k}:\n${a[k]}`);
        }
      } finally {
        rmSync(aDir, { recursive: true, force: true });
        rmSync(bDir, { recursive: true, force: true });
      }
    });
  }
});
