// ADR-0034 verification: the copyable reference templates (src/reference/*.ts) must
// produce BYTE-IDENTICAL output to the built-in generators they were relocated from.
// The reference generators import only "@metaobjectsdev/codegen-ts" (the public engine);
// if this passes, a consumer can copy them out and own them with no behavior change.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig, REFERENCE_GENERATOR_NAMES } from "../src/index.js";
import type { ReferenceGeneratorName, Generator } from "../src/index.js";
import { routesFileHono as builtinRoutesHono, namesFile as builtinNames } from "../src/generators/index.js";
import { barrel as builtinBarrel } from "../src/generators/barrel.js";
import { entityFile as builtinEntity } from "../src/generators/entity-file.js";
import { queriesFile as builtinQueries } from "../src/generators/queries-file.js";
import { routesFile as builtinRoutes } from "../src/generators/routes-file.js";
import { entityFile as refEntity } from "../src/reference/entity.js";
import { queriesFile as refQueries } from "../src/reference/queries.js";
import { routesFile as refRoutes } from "../src/reference/routes.js";
import { routesFileHono as refRoutesHono } from "../src/reference/routes-hono.js";
import { barrel as refBarrel } from "../src/reference/barrel.js";
import { namesFile as refNames } from "../src/reference/names.js";
import { promptRender as builtinPromptRender } from "../src/generators/prompt-render-file.js";
import { outputParser as builtinOutputParser } from "../src/generators/output-parser-file.js";
import { extractor as builtinExtractor } from "../src/generators/extractor-file.js";
import { outputPrompt as builtinOutputPrompt } from "../src/generators/output-prompt-file.js";
import { renderHelper as builtinRenderHelper } from "../src/generators/render-helper-file.js";
import { promptRender as refPromptRender } from "../src/reference/prompt-render.js";
import { outputParser as refOutputParser } from "../src/reference/output-parser.js";
import { extractor as refExtractor } from "../src/reference/extractor.js";
import { outputPrompt as refOutputPrompt } from "../src/reference/output-prompt.js";
import { renderHelper as refRenderHelper } from "../src/reference/render-helper.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE_DIR = resolve(import.meta.dir, "fixtures");
// test → codegen-ts → packages → typescript → server → repo root
const REPO_FIXTURES = resolve(import.meta.dir, "..", "..", "..", "..", "..", "fixtures");
const FIXTURES = [
  "single-entity.json",
  "two-entities-fk.json",
  "cross-package-vo.json",
  "trainer-website-shape.json",
  "packaged-shape.json",
  // An `extends` chain — an abstract base a sourced entity extends, plus a TPH subtype
  // sharing its base's table. Added because the names artifact learned to EXTEND its
  // parent's rather than restate it, and not one of the five fixtures above carries an
  // `extends` at all: the built-in and the reference copy could have diverged on the whole
  // new branch while this gate stayed green.
  "extends-chain.json",
  // An entity with `@autoSet` timestamps. Added because NOT ONE of the fixtures above
  // carried one, and `@autoSet` is the sole trigger for the #203 `insertPreserving<Entity>`
  // escape hatch + its `<Entity>InsertPreservingSchema` import — a whole branch of the
  // queries composer this gate could not see. It could not see it for a reason that
  // outlives this fixture: every model here was written to exercise SHAPE (packages,
  // FKs, value objects, extends), and `@autoSet` is a per-field write RULE, so no
  // shape-driven corpus grows one by accident. The reference copy had in fact lost the
  // branch, and the loss is silent — output simply lacks the function.
  "autoset-timestamps.json",
];

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-ref-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function gen(
  dir: string,
  generators: ReturnType<typeof builtinEntity>[],
  root: Parameters<typeof runGen>[0]["metadata"],
  projectRoot?: string,
) {
  await runGen({
    config: defineConfig({ outDir: dir, extStyle: "none", dbImport: "~/server/db", dialect: "sqlite", generators }),
    metadata: root,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
  });
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!f.isFile()) continue;
    const abs = join(f.parentPath, f.name);
    out[abs.slice(dir.length + 1)] = readFileSync(abs, "utf-8");
  }
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
  "prompt-render": { builtin: builtinPromptRender, ref: refPromptRender },
  "output-parser": { builtin: builtinOutputParser, ref: refOutputParser },
  extractor: { builtin: builtinExtractor, ref: refExtractor },
  "output-prompt": { builtin: builtinOutputPrompt, ref: refOutputPrompt },
  "render-helper": { builtin: builtinRenderHelper, ref: refRenderHelper },
};

// The prompt tier emits nothing for the entity-shaped fixtures above — none declares a
// template — so a pair there is compared over two empty sets. These corpora carry the
// nodes the prompt generators key on: the fitness corpus a RESPONDING template.prompt,
// the template.output corpus documents + emails with their Mustache files under
// `<projectRoot>/templates/`, which is where render-helper's gen-time drift gate reads.
// `templatesDir` is COPIED into a scratch project root rather than pointed at in place:
// runGen writes `.metaobjects/.gen-state/` under its projectRoot, and a shared fixture
// directory must not collect that state.
const PROMPT_TIER_CORPORA: ReadonlyArray<{ label: string; files: string[]; templatesDir?: string }> = [
  {
    label: "persistence-conformance fitness corpus (template.prompt + @responseRef)",
    files: [join(REPO_FIXTURES, "persistence-conformance", "canonical", "meta.fitness.json")],
  },
  {
    label: "template-output-render corpus (template.output documents + emails)",
    files: [join(REPO_FIXTURES, "template-output-render-conformance", "meta.json")],
    templatesDir: join(REPO_FIXTURES, "template-output-render-conformance", "templates"),
  },
];

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

describe("ADR-0034 — the prompt-tier reference templates over corpora that declare templates", () => {
  const PROMPT_TIER = ["prompt-render", "output-parser", "extractor", "output-prompt", "render-helper"] as const;

  for (const corpus of PROMPT_TIER_CORPORA) {
    test(corpus.label, async () => {
      const loader = new MetaDataLoader();
      const result = await loader.load(corpus.files.map((f) => new FileSource(f)));
      expect(result.errors).toEqual([]);

      const aDir = mkdtempSync(join(tmpdir(), "codegen-builtin-"));
      const bDir = mkdtempSync(join(tmpdir(), "codegen-reference-"));
      const projectRoot = mkdtempSync(join(tmpdir(), "codegen-project-"));
      if (corpus.templatesDir !== undefined) {
        cpSync(corpus.templatesDir, join(projectRoot, "templates"), { recursive: true });
      }
      try {
        // entity rides along because every prompt-tier module imports a value object's
        // interface from the module entity emits.
        const pick = (side: "builtin" | "ref") => [
          PAIRS.entity[side](),
          ...PROMPT_TIER.map((n) => PAIRS[n][side]()),
        ];
        const a = await gen(aDir, pick("builtin"), result.root, projectRoot);
        const b = await gen(bDir, pick("ref"), result.root, projectRoot);
        const aKeys = Object.keys(a).sort();
        // A gate over an empty emit passes trivially — assert the prompt tier produced files.
        expect(aKeys.filter((k) => /(\.(response|responseFormat|extractor|render)|^prompts)\.ts$/.test(k)).length)
          .toBeGreaterThan(0);
        expect(Object.keys(b).sort()).toEqual(aKeys);
        for (const k of aKeys) {
          expect(`${k}:\n${b[k]}`).toBe(`${k}:\n${a[k]}`);
        }
      } finally {
        rmSync(aDir, { recursive: true, force: true });
        rmSync(bDir, { recursive: true, force: true });
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  }
});
