// ADR-0034 verification: the copyable reference templates (src/reference/*.ts) must
// produce BYTE-IDENTICAL output to the built-in generators they were relocated from.
// The reference generators import only "@metaobjectsdev/codegen-ts" (the public engine);
// if this passes, a consumer can copy them out and own them with no behavior change.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig, REFERENCE_GENERATOR_NAMES, HTTP_RUNTIME_PACKAGE, OWNED_RUNTIME_DIR } from "../src/index.js";
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

// The route COMPOSITION moved into the reference (it used to call the engine's
// `renderRoutesFile`), so every branch of it now has two copies that must agree — and not
// one fixture above carries a projection, a write-through entity, an M:N navigation or a
// TPH hierarchy. These are the api-contract corpora whose GENERATED lane boots exactly
// those shapes, reused rather than re-modelled so the gate covers what that lane serves.
const ROUTE_SHAPE_CORPORA = ["projection", "write-through", "m2m", "tph", "jsonb"] as const;

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
//
// The three references whose OUTPUT imports the HTTP-adapter tier (ADR-0034 Amendment 3,
// 2026-09-24) default to the adapter copy `meta eject` places in `codegen/runtime/`. The
// built-ins import the package, so the pairing binds each reference to the package through
// its `runtimeImport` option: what this gate compares is the COMPOSITION. The local-copy
// spelling is gated separately below, as "the same bytes with the import moved".
const PKG = { runtimeImport: HTTP_RUNTIME_PACKAGE };
const PAIRS: Record<ReferenceGeneratorName, { builtin: () => Generator; ref: () => Generator }> = {
  entity: { builtin: builtinEntity, ref: () => refEntity(PKG) },
  queries: { builtin: builtinQueries, ref: refQueries },
  routes: { builtin: builtinRoutes, ref: () => refRoutes(PKG) },
  "routes-hono": { builtin: builtinRoutesHono, ref: () => refRoutesHono(PKG) },
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

async function loadFiles(files: string[]) {
  const result = await new MetaDataLoader().load(files.map((f) => new FileSource(f)));
  expect(result.errors).toEqual([]);
  return result.root;
}

describe("ADR-0034 — the route composition, over every shape it dispatches on", () => {
  for (const corpus of ROUTE_SHAPE_CORPORA) {
    test(`api-contract ${corpus} corpus`, async () => {
      const root = await loadFiles([join(REPO_FIXTURES, "api-contract-conformance", corpus, "meta.json")]);
      const aDir = mkdtempSync(join(tmpdir(), "codegen-builtin-"));
      const bDir = mkdtempSync(join(tmpdir(), "codegen-reference-"));
      try {
        const names = ["entity", "routes", "routes-hono"] as const;
        const a = await gen(aDir, names.map((n) => PAIRS[n].builtin()), root);
        const b = await gen(bDir, names.map((n) => PAIRS[n].ref()), root);
        const aKeys = Object.keys(a).sort();
        expect(aKeys.filter((k) => k.endsWith(".routes.ts")).length).toBeGreaterThan(0);
        expect(Object.keys(b).sort()).toEqual(aKeys);
        for (const k of aKeys) expect(`${k}:\n${b[k]}`).toBe(`${k}:\n${a[k]}`);
      } finally {
        rmSync(aDir, { recursive: true, force: true });
        rmSync(bDir, { recursive: true, force: true });
      }
    });
  }
});

describe("ADR-0034 Amendment 3 — an ejected generator's output imports the OWNED adapter copy", () => {
  // Default options, as `meta eject` leaves them: the output must be the built-in's bytes
  // with ONLY the adapter import moved to the copy — and must name the package nowhere.
  const LOCAL: Record<string, { builtin: () => Generator; ref: () => Generator }> = {
    entity: { builtin: builtinEntity, ref: () => refEntity() },
    routes: { builtin: builtinRoutes, ref: () => refRoutes() },
    "routes-hono": { builtin: builtinRoutesHono, ref: () => refRoutesHono() },
  };

  for (const corpus of ROUTE_SHAPE_CORPORA) {
    test(`api-contract ${corpus} corpus`, async () => {
      const root = await loadFiles([join(REPO_FIXTURES, "api-contract-conformance", corpus, "meta.json")]);
      const projectRoot = mkdtempSync(join(tmpdir(), "codegen-owned-runtime-"));
      const aDir = join(projectRoot, "builtin", "gen");
      const bDir = join(projectRoot, "src", "gen");
      try {
        const a = await gen(aDir, Object.values(LOCAL).map((p) => p.builtin()), root, projectRoot);
        const b = await gen(bDir, Object.values(LOCAL).map((p) => p.ref()), root, projectRoot);
        // outDir is `<root>/src/gen`, the copy is `<root>/codegen/runtime` — two levels up.
        const local = `../../${OWNED_RUNTIME_DIR}`;
        const moved = (src: string) =>
          src
            .replaceAll(`"${HTTP_RUNTIME_PACKAGE}/drizzle-fastify"`, "@@ADAPTER@@")
            .replaceAll(`"${HTTP_RUNTIME_PACKAGE}/hono"`, "@@ADAPTER@@")
            .replaceAll(`${HTTP_RUNTIME_PACKAGE}/drizzle-fastify`, "@@ADAPTER_DOC@@")
            .replaceAll(`${HTTP_RUNTIME_PACKAGE}/hono`, "@@ADAPTER_DOC@@");
        const localized = (src: string) =>
          src
            .replaceAll(`"${local}/drizzle-fastify/index"`, "@@ADAPTER@@")
            .replaceAll(`"${local}/hono/index"`, "@@ADAPTER@@")
            .replaceAll(`"${local}/drizzle-fastify/filter-allowlist"`, "@@ADAPTER@@")
            .replaceAll(`${local}/drizzle-fastify/index`, "@@ADAPTER_DOC@@")
            .replaceAll(`${local}/hono/index`, "@@ADAPTER_DOC@@");
        // The formatter orders a package import and a relative one differently, so the moved
        // import may change places in the import block. Compare that block as a SET of
        // statements (none carries a `;` before its end) and everything after it exactly.
        const IMPORT_RE = /^import [^;]*;\n/gm;
        const importsAsSet = (src: string) =>
          [...(src.match(IMPORT_RE) ?? [])].sort().join("") + src.replace(IMPORT_RE, "");
        const keys = Object.keys(a).sort();
        expect(Object.keys(b).sort()).toEqual(keys);
        let importing = 0;
        for (const k of keys) {
          expect(b[k]).not.toContain(HTTP_RUNTIME_PACKAGE);
          if (b[k] !== a[k]) importing++;
          expect(`${k}:\n${importsAsSet(localized(b[k]!))}`).toBe(`${k}:\n${importsAsSet(moved(a[k]!))}`);
        }
        // Vacuity guard: the corpus must actually exercise the moved import.
        expect(importing).toBeGreaterThan(0);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
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
