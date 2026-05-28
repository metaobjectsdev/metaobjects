// Cross-port byte-equivalence harness for templateGenerator().
//
// Fixture format: see fixtures/render-conformance/template-generator/README.md.
// For each fixture dir, materializes the meta.json into a MetaRoot, builds a
// walk function from walk.json, runs templateGenerator(), and asserts each
// emitted file equals expected/<outputPath> byte-for-byte.

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { InMemoryProvider, type RenderFormat } from "@metaobjectsdev/render";
import { templateGenerator } from "../../src/generators/template-generator.js";
import {
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_INT, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_DATE,
  OBJECT_SUBTYPE_ENTITY,
  type MetaRoot, type MetaObject,
} from "@metaobjectsdev/metadata";
import { metaRoot, metaObject, metaField } from "../_meta-build.js";
import type { GenContext } from "../../src/generator.js";

const CORPUS = join(
  import.meta.dir,
  "../../../../../../fixtures/render-conformance/template-generator",
);

interface FixtureField { name: string; type: string }
interface FixtureEntity { name: string; fields: FixtureField[] }
interface FixtureMeta { format: RenderFormat; entities: FixtureEntity[] }
interface WalkEntry { entity?: string; data: object; outputPath: string }

const FIELD_TYPE_MAP: Record<string, string> = {
  string: FIELD_SUBTYPE_STRING,
  long: FIELD_SUBTYPE_LONG,
  int: FIELD_SUBTYPE_INT,
  double: FIELD_SUBTYPE_DOUBLE,
  boolean: FIELD_SUBTYPE_BOOLEAN,
  date: FIELD_SUBTYPE_DATE,
};

function buildRootFromMeta(meta: FixtureMeta): MetaRoot {
  const root = metaRoot("root", "conformance");
  for (const e of meta.entities) {
    const obj = metaObject(OBJECT_SUBTYPE_ENTITY, e.name);
    for (const f of e.fields) {
      const subtype = FIELD_TYPE_MAP[f.type];
      if (!subtype) throw new Error(`Unknown field type "${f.type}" in fixture`);
      obj.addChild(metaField(subtype, f.name));
    }
    root.addChild(obj);
  }
  return root;
}

function makeCtx(root: MetaRoot): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
    warn: () => {},
  };
}

function fixtureDirs(): string[] {
  if (!existsSync(CORPUS)) return [];
  return readdirSync(CORPUS)
    .filter((n) => n.startsWith("fixture-"))
    .filter((n) => statSync(join(CORPUS, n)).isDirectory())
    .sort();
}

function collectExpectedFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(dir, "expected");
  if (!existsSync(root)) return out;
  function recurse(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) recurse(full);
      else out.set(relative(root, full), readFileSync(full, "utf8"));
    }
  }
  recurse(root);
  return out;
}

describe("template-generator conformance corpus", () => {
  const dirs = fixtureDirs();
  expect(dirs.length).toBeGreaterThan(0);

  for (const name of dirs) {
    describe(name, () => {
      const dir = join(CORPUS, name);
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as FixtureMeta;
      const tpl = readFileSync(join(dir, "template.mustache"), "utf8");
      const walk = JSON.parse(readFileSync(join(dir, "walk.json"), "utf8")) as WalkEntry[];
      const expected = collectExpectedFiles(dir);

      test("emits exactly the files declared in walk.json", async () => {
        const provider = new InMemoryProvider({ "conformance/template": tpl });
        const root = buildRootFromMeta(meta);
        const byName = new Map<string, MetaObject>(root.objects().map((o) => [o.name, o]));
        const gen = templateGenerator({
          name: name,
          template: "conformance/template",
          provider,
          format: meta.format,
          walk: () => walk.map((w) => {
            if (w.entity !== undefined && !byName.has(w.entity)) {
              throw new Error(`walk.json references unknown entity "${w.entity}"`);
            }
            return { data: w.data, outputPath: w.outputPath };
          }),
        });
        const files = await gen.generate(makeCtx(root));
        const emittedPaths = files.map((f) => f.path).sort();
        const expectedPaths = walk.map((w) => w.outputPath).sort();
        expect(emittedPaths).toEqual(expectedPaths);
      });

      for (const w of walk) {
        test(`expected/${w.outputPath} matches byte-for-byte`, async () => {
          const provider = new InMemoryProvider({ "conformance/template": tpl });
          const root = buildRootFromMeta(meta);
          const gen = templateGenerator({
            name: name,
            template: "conformance/template",
            provider,
            format: meta.format,
            walk: () => walk.map((x) => ({ data: x.data, outputPath: x.outputPath })),
          });
          const files = await gen.generate(makeCtx(root));
          const emitted = files.find((f) => f.path === w.outputPath);
          expect(emitted).toBeDefined();
          const exp = expected.get(w.outputPath);
          expect(exp).toBeDefined();
          expect(emitted!.content).toBe(exp!);
        });
      }
    });
  }
});
