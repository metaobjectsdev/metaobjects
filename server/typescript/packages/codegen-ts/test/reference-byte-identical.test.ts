// ADR-0034 verification: the copyable reference templates (src/reference/*.ts) must
// produce BYTE-IDENTICAL output to the built-in generators they were relocated from.
// The reference generators import only "@metaobjectsdev/codegen-ts" (the public engine);
// if this passes, a consumer can copy them out and own them with no behavior change.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig } from "../src/index.js";
import {
  entityFile as builtinEntity,
  queriesFile as builtinQueries,
  routesFile as builtinRoutes,
  barrel as builtinBarrel,
} from "../src/generators/index.js";
import { entityFile as refEntity } from "../src/reference/entity.js";
import { queriesFile as refQueries } from "../src/reference/queries.js";
import { routesFile as refRoutes } from "../src/reference/routes.js";
import { barrel as refBarrel } from "../src/reference/barrel.js";
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

describe("ADR-0034 — reference templates are byte-identical to built-ins", () => {
  for (const fixture of FIXTURES) {
    test(fixture, async () => {
      const loader = new MetaDataLoader();
      const result = await loader.load([new FileSource(join(FIXTURE_DIR, fixture))]);
      expect(result.errors).toEqual([]);

      const aDir = mkdtempSync(join(tmpdir(), "codegen-builtin-"));
      const bDir = mkdtempSync(join(tmpdir(), "codegen-reference-"));
      try {
        const a = await gen(aDir, [builtinEntity(), builtinQueries(), builtinRoutes(), builtinBarrel()], result.root);
        const b = await gen(bDir, [refEntity(), refQueries(), refRoutes(), refBarrel()], result.root);
        // same set of files
        expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
        // byte-identical contents
        for (const k of Object.keys(a)) {
          expect(`${k}:\n${b[k]}`).toBe(`${k}:\n${a[k]}`);
        }
      } finally {
        rmSync(aDir, { recursive: true, force: true });
        rmSync(bDir, { recursive: true, force: true });
      }
    });
  }
});
