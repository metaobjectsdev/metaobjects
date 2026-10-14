// ADR-0034 verification: the copyable reference templates (src/reference/*.ts) must
// produce BYTE-IDENTICAL output to the built-in generators they were relocated from.
// The reference generators import only "@metaobjectsdev/codegen-ts" (the public engine);
// if this passes, a consumer can copy them out and own them with no behavior change.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runGen, defineConfig, REFERENCE_GENERATOR_NAMES, HTTP_RUNTIME_PACKAGE, OWNED_RUNTIME_DIR,
  buildPkMap, buildRelationMap, makeRenderContext,
} from "../src/index.js";
import type { ReferenceGeneratorName, Generator, GenContext, DocsRunFacts, OutputLayout } from "../src/index.js";
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
import { requirementTests as builtinRequirementTests } from "../src/generators/requirement-tests.js";
import {
  requirementTests as refRequirementTests,
  renderRequirementTest as refRenderRequirementTest,
} from "../src/reference/requirement-tests.js";
import { renderRequirementTest as builtinRenderRequirementTest } from "../src/templates/requirement-test.js";
import { cubeModel as builtinCubeModel } from "../src/generators/cube-model.js";
import { cubeModel as refCubeModel } from "../src/reference/cube-model.js";
import { callableFile as builtinCallable } from "../src/generators/callable-file.js";
import { callableFile as refCallable } from "../src/reference/callable.js";
import { traceHelperFile as builtinTraceHelper } from "../src/generators/trace-helper-file.js";
import { traceHelperFile as refTraceHelper } from "../src/reference/trace-helper.js";
import { sharedModelFile as builtinSharedModel } from "../src/generators/shared-model-file.js";
import { sharedModelFile as refSharedModel } from "../src/reference/shared-model.js";
import { docsFile as builtinDocs } from "../src/generators/docs-file.js";
import { docsFile as refDocs } from "../src/reference/docs.js";
import { apiDocsFile as builtinApiDocs } from "../src/generators/api-docs-file.js";
import { apiDocsFile as refApiDocs } from "../src/reference/api-docs.js";
import { requirementsFile as builtinRequirements } from "../src/generators/requirements-file.js";
import { agentDocsFile as builtinAgentDocs } from "../src/generators/agent-docs-file.js";
import { requirementsFile as refRequirements } from "../src/reference/requirements.js";
import { agentDocsFile as refAgentDocs } from "../src/reference/agent-docs.js";
import { metamodelDocsFile as builtinMetamodelDocs } from "../src/generators/metamodel-docs-file.js";
import { metamodelDocsFile as refMetamodelDocs } from "../src/reference/metamodel-docs.js";
import { buildExpectedSchemaWithProvenance, columnTypeSql, qualifiedDbName } from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "../src/index.js";
import type { AgentSchemaInput, SchemaColumnLike } from "../src/index.js";
import { librarySources } from "@metaobjectsdev/metadata/library";
import {
  CANONICAL_CONFIG,
  CANONICAL_MODEL,
  CUBE_CORPUS_DIR,
  cubeModelTree,
  loadModelFile,
  readTree as readCubeTree,
} from "../scripts/gen-cube-model-canonical.js";
import type { RequirementTestArgs, RequirementTestsOpts } from "../src/index.js";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
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
    // The documentation generators write to the `docs` target, which a run must declare.
    config: defineConfig({
      outDir: dir, extStyle: "none", dbImport: "~/server/db", dialect: "sqlite", generators,
      targets: { docs: { outDir: join(dir, "_docs") } },
    }),
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
// What the shared-model pair publishes in the fixture loop: every node of one model that is
// publishable (all of its nodes are packaged and it needs core vocabulary only).
const SHARED_MODEL_OPTS = {
  name: "shared",
  include: ["**"],
  version: "1.2.3",
  files: [join(FIXTURE_DIR, "trainer-website-shape.json")],
};
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
  "requirement-tests": { builtin: builtinRequirementTests, ref: refRequirementTests },
  // Over the entity-shaped fixtures above this emits nothing (none declares reporting
  // vocabulary), so the pair is compared over two empty sets there; the describe at the end
  // of this file runs both over models that DO, under both Cube dialects.
  "cube-model": { builtin: builtinCubeModel, ref: refCubeModel },
  // Both emit nothing over the entity-shaped fixtures above (none declares a callable
  // source or a trace entity); the describe at the end of this file runs each pair over
  // a model that does.
  callable: { builtin: builtinCallable, ref: refCallable },
  "trace-helper": { builtin: builtinTraceHelper, ref: refTraceHelper },
  // It has no default selection, so it is constructed with options, and it loads its OWN
  // `files`: over the fixtures above it publishes one fixed model whichever fixture the loop
  // is on. The describe at the end of this file runs the pair over each publishable model,
  // the version default and every refusal.
  "shared-model": {
    builtin: () => builtinSharedModel(SHARED_MODEL_OPTS),
    ref: () => refSharedModel(SHARED_MODEL_OPTS),
  },
  // The documentation generators (ADR-0034 Amendment 9), run like the rest into the `docs`
  // target. The describes at the end of this file run each pair over corpora with reports,
  // templates, a ledger and a physical schema, and with the cross-link facts varied.
  docs: { builtin: builtinDocs, ref: refDocs },
  "api-docs": { builtin: builtinApiDocs, ref: refApiDocs },
  requirements: { builtin: builtinRequirements, ref: refRequirements },
  "agent-docs": { builtin: builtinAgentDocs, ref: refAgentDocs },
  "metamodel-docs": { builtin: builtinMetamodelDocs, ref: refMetamodelDocs },
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

// The requirement-test reference is the one template that carries a RENDERER as well as a
// generator: an eject copies one file, and the stub text is what an application is most
// likely to change, so both live in it. That makes the copy larger than its siblings —
// every status branch, both escaping paths, the gap line, the uncovered warning — and no
// fixture above declares a requirement, so each of those would be compared over two empty
// sets. This ledger reaches every one of them.
const REQUIREMENT_LEDGER = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "note" } },
            { "field.string": { name: "memo" } },
            { "source.rdb": { "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "requirement.functional": {
          name: "Orders",
          "@level": 3,
          "@status": "live",
          "@statement": "Orders are taken.",
          "@counterexample": "an order nobody can place",
          children: [
            {
              // L4, live, claiming the entity twice over — bare and package-qualified.
              "requirement.functional": {
                name: "Recorded",
                "@level": 4,
                "@status": "live",
                "@statement": "An order is recorded when it is placed.",
                "@counterexample": "A placed order has no row.",
                "@implementedBy": ["Order", "acme::shop::Order"],
                children: [
                  {
                    // L5, partial with a tracked gap, two members of ONE concern, and
                    // prose that must be escaped in a string literal and in a comment.
                    "requirement.functional": {
                      name: "Annotated",
                      "@level": 5,
                      "@status": "partial",
                      "@disposition": "deferred",
                      "@trackedBy": ["#12", "a */ tracker"],
                      "@statement": "The note is kept \"verbatim\" */ as typed.\nOn every order.",
                      "@counterexample": "a note with a \\ dropped\r\nor a \"tidied\" one",
                      "@implementedBy": ["Order.note", "Order.memo"],
                    },
                  },
                ],
              },
            },
            {
              // Planned: skipped, and naming a node that does not exist yet.
              "requirement.functional": {
                name: "Refunded",
                "@level": 4,
                "@status": "planned",
                "@statement": "A refund is recorded against its order.",
                "@counterexample": "A refund with no order.",
                "@implementedBy": ["Refund"],
              },
            },
            {
              // Retired: skipped, with its own body.
              "requirement.functional": {
                name: "Faxed",
                "@level": 4,
                "@status": "retired",
                "@statement": "An order can be faxed in.",
                "@counterexample": "a fax line that answers",
              },
            },
            {
              // Live with no targets at all.
              "requirement.functional": {
                name: "Acknowledged",
                "@level": 4,
                "@status": "live",
                "@statement": "An order is acknowledged.",
                "@counterexample": "a silent checkout",
              },
            },
            {
              // A gap somebody is tracking and nobody has ruled on: `@trackedBy` with no
              // `@disposition`, which the stub records as "undecided".
              "requirement.functional": {
                name: "Chased",
                "@level": 4,
                "@status": "partial",
                "@trackedBy": ["#77"],
                "@statement": "An unpaid order is chased.",
                "@counterexample": "an unpaid order nobody hears about",
              },
            },
          ],
        },
      },
      {
        "requirement.architectural": {
          name: "Audited",
          "@status": "live",
          "@statement": "Every entity is audited.",
          "@counterexample": "an entity with no audit trail",
          "@implementedBy": ["Order"],
        },
      },
    ],
  },
};

describe("ADR-0034 — the requirement-tests reference over a ledger that declares requirements", () => {
  // Where a run moves the stubs to, and the namespace that goes with it.
  const specPath: NonNullable<RequirementTestsOpts["path"]> = (view, key) =>
    `specs/${view.path}__${key.replace(/[^A-Za-z0-9]+/g, "_")}.spec.ts`;
  const ownsSpecs = (relPath: string): boolean => relPath.startsWith("specs/");

  // `warns` names a sentence the run MUST produce. The warnings are compared between the
  // two generators either way; this is what stops that comparison passing over two
  // empty lists when the branch under test was never reached.
  const RUNS: ReadonlyArray<{ label: string; opts: RequirementTestsOpts; files: number; warns?: string }> = [
    // Recorded, Annotated, Refunded, Faxed, Acknowledged, Chased — one concern each.
    { label: "the defaults", opts: {}, files: 6, warns: "2 requirement(s) matched no filter" },
    // Every requirement (the L3 parent and the architectural policy included), one stub
    // per reference: Orders 1, Recorded 2, Annotated 2, Refunded 1, Faxed 1,
    // Acknowledged 1, Chased 1, Audited 1.
    { label: 'grain: "member" under a filter that keeps everything', opts: { grain: "member", filter: () => true }, files: 10 },
    // A filter that drops requirements while the warning is on, in the default grain.
    { label: "a filter by package and status", opts: { filter: (r) => r.package === "acme::shop" && r.status !== "retired" }, files: 7, warns: "Uncovered: Orders.Faxed." },
    { label: "the uncovered warning switched off", opts: { warnUncovered: false }, files: 6 },
    // Seven of the eight requirements uncovered: five are named and the rest counted.
    { label: "more uncovered requirements than the warning names", opts: { filter: (r) => r.path === "Orders.Recorded" }, files: 1, warns: ", and 2 more." },
    // A custom `path` with no `owns`: the stubs move and the generator says it can no
    // longer clean up after a deleted requirement.
    { label: "a custom path without owns", opts: { path: specPath }, files: 6, warns: "a custom 'path' was supplied without a matching 'owns'" },
    { label: "a custom path with its owns, under member grain", opts: { path: specPath, owns: ownsSpecs, grain: "member", forceOrphanDelete: true }, files: 8, warns: "2 requirement(s) matched no filter" },
    { label: "a custom path with orphan reconciliation off", opts: { path: specPath, reconcileOrphans: false, warnUncovered: false }, files: 6 },
  ];

  for (const run of RUNS) {
    test(run.label, async () => {
      const loaded = await new MetaDataLoader().load([
        new InMemoryStringSource(JSON.stringify(REQUIREMENT_LEDGER)),
      ]);
      expect(loaded.errors).toEqual([]);

      const emit = async (generator: Generator) => {
        const dir = mkdtempSync(join(tmpdir(), "codegen-req-"));
        try {
          const result = await runGen({
            config: defineConfig({ outDir: join(dir, "out"), extStyle: "none", dbImport: "~/server/db", dialect: "sqlite", generators: [generator] }),
            metadata: loaded.root,
            projectRoot: dir,
          });
          const files: Record<string, string> = {};
          for (const f of readdirSync(join(dir, "out"), { recursive: true, withFileTypes: true })) {
            if (!f.isFile()) continue;
            const abs = join(f.parentPath, f.name);
            files[abs.slice(join(dir, "out").length + 1)] = readFileSync(abs, "utf-8");
          }
          return { files, warnings: result.warnings };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };

      const a = await emit(builtinRequirementTests(run.opts));
      const b = await emit(refRequirementTests(run.opts));
      const aKeys = Object.keys(a.files).sort();
      // A gate over an empty emit passes trivially.
      expect(aKeys.length).toBe(run.files);
      expect(Object.keys(b.files).sort()).toEqual(aKeys);
      for (const k of aKeys) expect(`${k}:\n${b.files[k]}`).toBe(`${k}:\n${a.files[k]}`);
      // The warning text is duplicated in the copy too, so it is compared too.
      expect(b.warnings).toEqual(a.warnings);
      if (run.warns === undefined) expect(a.warnings).toEqual([]);
      else expect(a.warnings.join("\n")).toContain(run.warns);
    });
  }

  test("the ledger reaches the undecided gap line", async () => {
    // Vacuity guard for the one stub branch only this requirement takes.
    const loaded = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(REQUIREMENT_LEDGER)),
    ]);
    const ctx = { loadedRoot: loaded.root, warn: () => {} } as unknown as Parameters<Generator["generate"]>[0];
    const files = await refRequirementTests().generate(ctx);
    const chased = files.find((f) => f.path === "requirements/Orders.Chased.test.ts");
    expect(chased?.content).toContain(" * Known gap: undecided — #77");
  });
});

// Everything above compares what a generator WRITES. A generator is also an object the
// runner reads: its name, its target, and above all its orphan policy, which decides
// which previously-generated files the runner may DELETE. A copy whose `owns` claimed
// more than the built-in's would remove another generator's output, and no emitted
// file would show it.
describe("ADR-0034 — the requirement-tests reference is the same GENERATOR, not just the same output", () => {
  const specPath: NonNullable<RequirementTestsOpts["path"]> = (view, key) => `specs/${view.path}.${key}.spec.ts`;
  const SAMPLE_PATHS = [
    "requirements/Orders.Recorded.object.entity.test.ts",
    "requirements/deep/nested.test.ts",
    "requirements",
    "requirementsElsewhere/a.test.ts",
    "specs/Orders.Recorded.object.entity.spec.ts",
    "Order.ts",
    "",
  ];

  const shape = (g: Generator) => ({
    name: g.name,
    target: g.target,
    reconciles: g.orphanPolicy !== undefined,
    force: g.orphanPolicy?.force,
    owns: g.orphanPolicy === undefined ? null : SAMPLE_PATHS.filter((p) => g.orphanPolicy?.owns(p)),
  });

  // `expected` is the built-in's shape written out, so the comparison below cannot
  // pass by both sides being wrong together (or both claiming nothing at all).
  const CASES: ReadonlyArray<{ label: string; opts: RequirementTestsOpts; expected: ReturnType<typeof shape> }> = [
    {
      label: "the defaults own the default stub directory, and nothing beside it",
      opts: {},
      expected: {
        name: "requirement-tests",
        target: undefined,
        reconciles: true,
        force: undefined,
        owns: ["requirements/Orders.Recorded.object.entity.test.ts", "requirements/deep/nested.test.ts"],
      },
    },
    {
      label: "member grain owns the same directory",
      opts: { grain: "member" },
      expected: {
        name: "requirement-tests",
        target: undefined,
        reconciles: true,
        force: undefined,
        owns: ["requirements/Orders.Recorded.object.entity.test.ts", "requirements/deep/nested.test.ts"],
      },
    },
    {
      label: "the name and the target are the application's",
      opts: { name: "req-api", target: "api-tests" },
      expected: {
        name: "req-api",
        target: "api-tests",
        reconciles: true,
        force: undefined,
        owns: ["requirements/Orders.Recorded.object.entity.test.ts", "requirements/deep/nested.test.ts"],
      },
    },
    {
      label: "a custom path without owns claims NOTHING",
      opts: { path: specPath },
      expected: { name: "requirement-tests", target: undefined, reconciles: true, force: undefined, owns: [] },
    },
    {
      label: "a custom path with owns claims exactly what owns says",
      opts: { path: specPath, owns: (p) => p.startsWith("specs/") },
      expected: {
        name: "requirement-tests",
        target: undefined,
        reconciles: true,
        force: undefined,
        owns: ["specs/Orders.Recorded.object.entity.spec.ts"],
      },
    },
    {
      label: "forceOrphanDelete sets force",
      opts: { forceOrphanDelete: true },
      expected: {
        name: "requirement-tests",
        target: undefined,
        reconciles: true,
        force: true,
        owns: ["requirements/Orders.Recorded.object.entity.test.ts", "requirements/deep/nested.test.ts"],
      },
    },
    {
      label: "reconcileOrphans: false declares no policy at all",
      opts: { reconcileOrphans: false, forceOrphanDelete: true },
      expected: { name: "requirement-tests", target: undefined, reconciles: false, force: undefined, owns: null },
    },
  ];

  for (const c of CASES) {
    test(c.label, () => {
      const builtin = shape(builtinRequirementTests(c.opts));
      expect(builtin).toEqual(c.expected);
      expect(shape(refRequirementTests(c.opts))).toEqual(builtin);
    });
  }

  test("an unknown grain is refused by both, in the same words", () => {
    const typo = { grain: "members" } as unknown as RequirementTestsOpts;
    const refusal = (make: () => Generator): string => {
      try {
        make();
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      return "(did not throw)";
    };
    const builtin = refusal(() => builtinRequirementTests(typo));
    expect(builtin).toBe('unknown requirement-test grain "members": expected "concern" or "member".');
    expect(refusal(() => refRequirementTests(typo))).toBe(builtin);
  });
});

// The renderer is exported from the copy too, and an application may call it with
// arguments it built itself. Rendering through a generator only ever supplies arguments
// that agree with each other, so the two renderers are also compared directly — over
// every status, with the identity's `skip` field set to agree with it and to contradict
// it. The default renderer reads the STATUS; a copy that read `skip` instead passed
// every generator run above and diverged here.
describe("ADR-0034 — the requirement-tests reference renders hand-built arguments identically", () => {
  const STATUSES = ["live", "partial", "planned", "retired", undefined] as const;
  const SKIPS = [null, "planned", "retired"] as const;
  const EXTRAS: ReadonlyArray<Partial<RequirementTestArgs>> = [
    {},
    { disposition: "accepted" },
    { trackedBy: ["#1", "a */ b"] },
    {
      disposition: "deferred",
      trackedBy: ["#2"],
      targets: [{ ref: "Order.note", concern: "field.string", node: {} as never }],
    },
  ];

  for (const status of STATUSES) {
    for (const skip of SKIPS) {
      test(`status ${status ?? "(absent)"}, skip ${skip ?? "null"}`, () => {
        for (const extra of EXTRAS) {
          const args: RequirementTestArgs = {
            view: { subType: "functional", level: 4, status, path: 'Orders."Quoted"', package: "acme::shop", implementedByTypes: [] },
            concern: "object.entity",
            statement: "A statement */ with a break.\nAnd a second line.",
            counterexample: 'a "quoted" \\ counterexample\r\nover two lines',
            targets: [],
            package: "acme::shop",
            unit: "object.entity",
            id: 'acme::shop::Orders."Quoted" [object.entity]',
            witnessKey: "req_acme_shop_Orders_Quoted__object_entity",
            skip,
            digest: "0".repeat(64),
            ...extra,
          };
          expect(refRenderRequirementTest(args)).toBe(builtinRenderRequirementTest(args));
        }
      });
    }
  }
});

// The cube-model reference is the same GENERATOR as the built-in, not only the same output: a
// copy whose `owns` claimed more than the built-in's would remove somebody else's file on a
// full run, and no emitted file would show it. So both halves are compared — what the two WRITE
// (the canonical model, then every case in the mapping corpus, errors included, then a narrowed
// run), and what the runner READS from them (name, target, filter, orphan namespace).
describe("ADR-0034 — the cube-model reference is byte-identical to the built-in", () => {
  /** What one run did: the tree it wrote, or the message it threw (the runner's wrapper unwrapped). */
  async function outcome(
    make: () => Generator,
    root: Parameters<typeof cubeModelTree>[0],
    config: Parameters<typeof cubeModelTree>[1],
  ): Promise<{ tree: [string, string][] } | { threw: string }> {
    try {
      return { tree: [...(await cubeModelTree(root, config, make())).entries()] };
    } catch (err) {
      let at: unknown = err;
      while (at instanceof Error && at.cause instanceof Error) at = at.cause;
      return { threw: at instanceof Error ? at.message : String(at) };
    }
  }

  test("the canonical fitness model, postgres: the same cubes and views, byte for byte", async () => {
    const root = await loadModelFile(CANONICAL_MODEL);
    const a = await outcome(builtinCubeModel, root, CANONICAL_CONFIG);
    const b = await outcome(refCubeModel, root, CANONICAL_CONFIG);
    // A gate over an empty emit passes trivially. The four @spine reports are views, each with its
    // facts cube; ProgramSessions reaches its facts through the Session -> Week reference.
    expect("tree" in a ? a.tree.map(([p]) => p) : a).toEqual([
      "model/cubes/AllTypes.yml", "model/cubes/Asset.yml", "model/cubes/Auth.yml", "model/cubes/BridgeAuth.yml",
      "model/cubes/CopayAuth.yml", "model/cubes/Measurement.yml", "model/cubes/Node.yml", "model/cubes/Node_fkParent.yml",
      "model/cubes/PriorAuthAuth.yml", "model/cubes/Program.yml", "model/cubes/ProgramFlagRosterFacts.yml",
      "model/cubes/ProgramLongWeeksFacts.yml", "model/cubes/ProgramRosterFacts.yml", "model/cubes/ProgramSessionsFacts.yml",
      "model/cubes/ProgramSessions_fkWeek.yml", "model/cubes/ReferralAuth.yml", "model/cubes/Session.yml",
      "model/cubes/Week.yml", "model/views/ProgramFlagRoster.yml", "model/views/ProgramLongWeeks.yml",
      "model/views/ProgramRoster.yml", "model/views/ProgramSessions.yml",
    ]);
    expect(b).toEqual(a);
  });

  test("every case in the mapping corpus: the same tree or the same refusal", async () => {
    const cases = readdirSync(CUBE_CORPUS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "canonical")
      .map((e) => e.name)
      .sort();
    let trees = 0;
    let refusals = 0;
    for (const name of cases) {
      const dir = join(CUBE_CORPUS_DIR, name);
      const root = await loadModelFile(join(dir, "meta.json"));
      const caseFile = join(dir, "case.json");
      const json = existsSync(caseFile)
        ? (JSON.parse(readFileSync(caseFile, "utf8")) as { dialect?: "postgres" | "mysql" | "sqlite"; columnNamingStrategy?: "snake_case" | "literal" | "kebab-case" })
        : {};
      const config = {
        dialect: json.dialect ?? "postgres",
        ...(json.columnNamingStrategy !== undefined ? { columnNamingStrategy: json.columnNamingStrategy } : {}),
      };
      const a = await outcome(builtinCubeModel, root, config);
      const b = await outcome(refCubeModel, root, config);
      expect({ name, ...b }).toEqual({ name, ...a });
      if ("tree" in a) trees++;
      else refusals++;
    }
    // Vacuity guard: the corpus must reach both the writing and the refusing branches.
    expect(cases.length).toBeGreaterThan(30);
    expect(trees).toBeGreaterThan(20);
    expect(refusals).toBeGreaterThanOrEqual(10);
  });

  /** The tree a run writes into a scratch project, so the runner's own selection applies. */
  async function runTree(make: () => Generator, extra: Partial<Parameters<typeof runGen>[0]>, config: { dialect: "postgres" | "mysql" | "sqlite" }) {
    const root = await loadModelFile(CANONICAL_MODEL);
    const dir = mkdtempSync(join(tmpdir(), "cube-ref-run-"));
    try {
      await runGen({
        config: defineConfig({ outDir: join(dir, "out"), columnNamingStrategy: "literal", dialect: config.dialect, generators: [make()] }),
        metadata: root,
        projectRoot: dir,
        ...extra,
      });
      return [...readCubeTree(join(dir, "out")).entries()];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a run that names an entity writes the same subset: its cube, the cubes it reaches, and the views they hold", async () => {
    const run = (make: () => Generator) => runTree(make, { entityFilter: ["Week"] }, { dialect: "postgres" });
    const a = await run(builtinCubeModel);
    // Narrower than the full run (no Asset.yml), and not empty: Week reaches Program, Program the
    // four facts cubes (ProgramSessionsFacts through the Session -> Week join-path cube), and with
    // every cube they read written the four views are too.
    expect(a.map(([p]) => p)).toEqual([
      "model/cubes/Program.yml", "model/cubes/ProgramFlagRosterFacts.yml", "model/cubes/ProgramLongWeeksFacts.yml",
      "model/cubes/ProgramRosterFacts.yml", "model/cubes/ProgramSessionsFacts.yml", "model/cubes/ProgramSessions_fkWeek.yml",
      "model/cubes/Week.yml", "model/views/ProgramFlagRoster.yml", "model/views/ProgramLongWeeks.yml",
      "model/views/ProgramRoster.yml", "model/views/ProgramSessions.yml",
    ]);
    expect(await run(refCubeModel)).toEqual(a);
  });

  test("the dialect option beats a sqlite config, and a filter narrows the BUILD, in both", async () => {
    // Only Asset and Program are kept (Week, and Session which also reaches Week, are filtered out).
    // Program.yml's `title` dimension exists only because Week's @via reads it, so a copy that built
    // the whole model and merely hid the other files would still write it.
    const opts = { dialect: "mysql", filter: (o: { name: string }) => o.name === "Asset" || o.name === "Program" } as const;
    const a = await runTree(() => builtinCubeModel(opts), {}, { dialect: "sqlite" });
    expect(a.map(([p]) => p)).toEqual(["model/cubes/Asset.yml", "model/cubes/Program.yml"]);
    expect(a.every(([, text]) => text.includes("`"))).toBe(true);
    expect(a.find(([p]) => p === "model/cubes/Program.yml")![1]).not.toContain("name: title");
    expect(await runTree(() => refCubeModel(opts), {}, { dialect: "sqlite" })).toEqual(a);
  });

  // `shape` is everything the runner reads off a generator besides what it generates.
  const SAMPLE_PATHS = [
    "model/cubes/Week.yml",
    "model/cubes/Match_fkHome.yml",
    "model/cubes/deep/Week.yml",
    "model/cubes/Week.yaml",
    "model/cubes/Week.ts",
    "model/cubes",
    "model/views/Overview.yml",
    "model/views/deep/Overview.yml",
    "model/views/Overview.yaml",
    "Week.yml",
    "",
  ];
  const shape = (g: Generator) => ({
    name: g.name,
    target: g.target,
    filtered: g.filter !== undefined,
    reconciles: g.orphanPolicy !== undefined,
    force: g.orphanPolicy?.force,
    owns: g.orphanPolicy === undefined ? null : SAMPLE_PATHS.filter((p) => g.orphanPolicy?.owns(p)),
  });

  test("the defaults: the name, no target, no filter, and a cleanup that claims only model/cubes/*.yml and model/views/*.yml", () => {
    const builtin = shape(builtinCubeModel());
    // The built-in's shape written out, so the comparison cannot pass by both being wrong.
    expect(builtin).toEqual({
      name: "cube-model",
      target: undefined,
      filtered: false,
      reconciles: true,
      force: undefined,
      owns: ["model/cubes/Week.yml", "model/cubes/Match_fkHome.yml", "model/views/Overview.yml"],
    });
    expect(shape(refCubeModel())).toEqual(builtin);
  });

  test("the target and the filter are the application's, and the namespace does not move with them", () => {
    const opts = { target: "analytics", filter: () => true } as const;
    const builtin = shape(builtinCubeModel(opts));
    expect(builtin.target).toBe("analytics");
    expect(builtin.filtered).toBe(true);
    expect(builtin.owns).toEqual(["model/cubes/Week.yml", "model/cubes/Match_fkHome.yml", "model/views/Overview.yml"]);
    expect(shape(refCubeModel(opts))).toEqual(builtin);
  });
});

// `callable` and `trace-helper` key on shapes no fixture above carries: a source that is a
// stored procedure or a table function, and an entity extending the `ai` library's trace
// anchor with a nested prompt. Without these models each pair would be compared over two
// empty sets, which is how a reference template ships having lost a branch.
const CALLABLE_MODEL = {
  "metadata.root": {
    package: "demo",
    children: [
      {
        "object.value": {
          name: "PhaseSummaryArgs",
          children: [
            { "field.int": { name: "caseId", "@required": true } },
            { "field.timestamp": { name: "asOfDate" } },
          ],
        },
      },
      {
        // A stored procedure taking typed arguments.
        "object.projection": {
          name: "PhaseSummary",
          children: [
            { "source.rdb": { "@kind": "storedProc", "@proc": "fn_phase_summary", "@parameterRef": "PhaseSummaryArgs" } },
            { "field.long": { name: "phaseId" } },
            { "field.string": { name: "phaseName" } },
          ],
        },
      },
      {
        // A zero-argument table function: no `args` parameter, an empty call list.
        "object.projection": {
          name: "OpenCase",
          children: [
            { "source.rdb": { "@kind": "tableFunction", "@function": "fn_open_cases" } },
            { "field.long": { name: "caseId" } },
          ],
        },
      },
      {
        // An ordinary table: must emit no wrapper on either side.
        "object.entity": {
          name: "Case",
          children: [
            { "field.long": { name: "id" } },
            { "source.rdb": { "@table": "cases" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
};

/** One trace entity over the shipped `ai` anchor; `prompt` varies the branch under test. */
function traceEntity(name: string, table: string, prompt: Record<string, unknown>) {
  return {
    "object.entity": {
      name,
      extends: "metaobjects::ai::LlmCallBase",
      children: [
        { "source.rdb": { "@table": table, "@role": "primary" } },
        { "identity.primary": { name: "id", "@fields": ["traceId"] } },
        { "template.prompt": { name: `${name}Prompt`, "@payloadRef": "AskVO", "@responseRef": "AnswerVO", ...prompt } },
      ],
    },
  };
}

const TRACE_MODEL = {
  "metadata.root": {
    package: "app::ops",
    children: [
      { "object.value": { name: "AskVO", children: [{ "field.string": { name: "question" } }] } },
      { "object.value": { name: "AnswerVO", children: [{ "field.string": { name: "answer" } }] } },
      // A JSON prompt body and a JSON reply.
      traceEntity("ApiCall", "api_call", { "@textRef": "p/ask", "@format": "json" }),
      // A plain-text body eliciting an XML reply: the other format literal, and the case
      // where the body's @format and the reply's @responseFormat differ (ADR-0053).
      traceEntity("AuditCall", "audit_call", { "@textRef": "p/audit", "@format": "text", "@responseFormat": "xml" }),
    ],
  },
};

describe("ADR-0034 — the callable and trace-helper reference templates over models that carry them", () => {
  async function compare(
    root: Parameters<typeof runGen>[0]["metadata"],
    names: readonly ReferenceGeneratorName[],
    emitted: RegExp,
    expected: number,
  ) {
    const aDir = mkdtempSync(join(tmpdir(), "codegen-builtin-"));
    const bDir = mkdtempSync(join(tmpdir(), "codegen-reference-"));
    try {
      const a = await gen(aDir, names.map((n) => PAIRS[n].builtin()), root);
      const b = await gen(bDir, names.map((n) => PAIRS[n].ref()), root);
      const aKeys = Object.keys(a).sort();
      // Vacuity guard: exactly the modules the model asks for, no more and no fewer.
      expect(aKeys.filter((k) => emitted.test(k)).length).toBe(expected);
      expect(Object.keys(b).sort()).toEqual(aKeys);
      for (const k of aKeys) expect(`${k}:\n${b[k]}`).toBe(`${k}:\n${a[k]}`);
    } finally {
      rmSync(aDir, { recursive: true, force: true });
      rmSync(bDir, { recursive: true, force: true });
    }
  }

  test("callable — a stored procedure with arguments, a zero-argument table function, and a plain table", async () => {
    const result = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(CALLABLE_MODEL), { id: "callable.json", format: "json" }),
    ]);
    expect(result.errors).toEqual([]);
    await compare(result.root, ["entity", "callable"], /\.callable\.ts$/, 2);
  });

  test("trace-helper — a JSON reply and an XML one, over the shipped anchor", async () => {
    const result = await new MetaDataLoader().load([
      ...librarySources(["ai"]),
      new InMemoryStringSource(JSON.stringify(TRACE_MODEL), { id: "trace.json", format: "json" }),
    ]);
    expect(result.errors).toEqual([]);
    await compare(result.root, ["entity", "trace-helper"], /\.trace\.ts$/, 2);
  });
});


// ---------------------------------------------------------------------------------------
// ADR-0034 Amendment 7 — the last three: shared-model, docs, api-docs.
// ---------------------------------------------------------------------------------------

/** What one side did: the files it emitted, in order, or the message it threw (the
 *  runner's wrapper unwrapped, so a refusal is compared in the generator's own words). */
type Outcome = { files: [string, string][] } | { threw: string };

async function outcomeOf(run: () => Promise<[string, string][]>): Promise<Outcome> {
  try {
    return { files: await run() };
  } catch (err) {
    let at: unknown = err;
    while (at instanceof Error && at.cause instanceof Error) at = at.cause;
    return { threw: at instanceof Error ? at.message : String(at) };
  }
}

function paths(o: Outcome): string[] {
  if ("threw" in o) throw new Error(`expected files, got a refusal: ${o.threw}`);
  return o.files.map(([p]) => p);
}

// The artifact a publisher's `meta gen` writes is what a consumer's `meta deps sync` hashes
// and loads, so "the same output" here means the same two files to the byte AND the same
// refusal in the same words: a copy that published a model the built-in refuses would hand
// a consumer an artifact it cannot load. (That the artifact then VERIFIES in a consumer is
// gated end to end where both packages meet, in cli/test/integration.)
describe("ADR-0034 Amendment 7 — the shared-model reference publishes the same artifact", () => {
  type Opts = Parameters<typeof builtinSharedModel>[0];

  /** One `meta gen` of the generator alone, in a throwaway project. `sourceFiles` is what
   *  the CLI passes for the project's own files; `packageVersion` writes a package.json. */
  async function publish(
    make: (opts: Opts) => Generator,
    opts: Opts,
    run: { model: string; sourceFiles?: readonly string[]; packageVersion?: string },
  ): Promise<Outcome> {
    const project = mkdtempSync(join(tmpdir(), "codegen-shared-"));
    try {
      if (run.packageVersion !== undefined) {
        writeFileSync(join(project, "package.json"), JSON.stringify({ name: "p", version: run.packageVersion }));
      }
      const outDir = join(project, "out");
      mkdirSync(outDir);
      const root = await loadFiles([run.model]);
      return await outcomeOf(async () => {
        await runGen({
          config: defineConfig({ outDir, extStyle: "none", dbImport: "~/db", dialect: "sqlite", generators: [make(opts)] }),
          metadata: root,
          projectRoot: project,
          ...(run.sourceFiles !== undefined ? { sourceFiles: run.sourceFiles } : {}),
        });
        return readdirSync(outDir).sort().map((f): [string, string] => [f, readFileSync(join(outDir, f), "utf-8")]);
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }

  async function both(opts: Opts, run: Parameters<typeof publish>[2]): Promise<Outcome> {
    const a = await publish(builtinSharedModel, opts, run);
    const b = await publish(refSharedModel, opts, run);
    expect(b).toEqual(a);
    return a;
  }

  const FITNESS = join(REPO_FIXTURES, "persistence-conformance", "canonical", "meta.fitness.json");
  const PUBLISHABLE = [
    ...["single-entity.json", "two-entities-fk.json", "cross-package-vo.json", "trainer-website-shape.json",
      "extends-chain.json", "autoset-timestamps.json"].map((f) => join(FIXTURE_DIR, f)),
    FITNESS,
  ];

  for (const model of PUBLISHABLE) {
    test(`${model.slice(model.lastIndexOf("/") + 1)}: the artifact and its manifest, byte for byte`, async () => {
      const a = await both({ name: "shared", include: ["**"], version: "1.2.3" }, { model, sourceFiles: [model] });
      // Vacuity guard: both files, under the names `meta deps sync` reads.
      expect(paths(a)).toEqual(["metaobjects.pkg.json", "shared.metaobjects.json"]);
    });
  }

  test("the version default: the nearest package.json, in both", async () => {
    const a = await both({ name: "shared", include: ["**"] }, { model: FITNESS, sourceFiles: [FITNESS], packageVersion: "3.4.5" });
    const manifest = JSON.parse(("files" in a ? a.files : []).find(([p]) => p === "metaobjects.pkg.json")?.[1] ?? "{}") as { version?: string };
    expect(manifest.version).toBe("3.4.5");
  });

  test("`files` narrows what may contribute and wins over the run's own files", async () => {
    const one = join(FIXTURE_DIR, "single-entity.json");
    const a = await both({ name: "shared", include: ["**"], version: "1.0.0", files: [one] }, { model: FITNESS, sourceFiles: [FITNESS] });
    const manifest = JSON.parse(("files" in a ? a.files : []).find(([p]) => p === "metaobjects.pkg.json")?.[1] ?? "{}") as { nodes?: string[] };
    expect(manifest.nodes).toEqual(["demo::Post"]);
  });

  // Every refusal, in the same words. Each `threw` is asserted against the built-in's own
  // message so the comparison cannot pass over two unrelated failures.
  const REFUSALS: ReadonlyArray<{ label: string; opts: Opts; run: Parameters<typeof publish>[2]; says: RegExp }> = [
    {
      label: "no source files",
      opts: { name: "shared", include: ["**"], version: "1.0.0" },
      run: { model: FITNESS },
      says: /no source files to load/,
    },
    {
      label: "an include that selects nothing",
      opts: { name: "shared", include: ["nowhere::**"], version: "1.0.0" },
      run: { model: FITNESS, sourceFiles: [FITNESS] },
      says: /selected no nodes/,
    },
    {
      label: "a selection that is not closed",
      opts: { name: "shared", include: ["fitness::**"], exclude: ["fitness::Program"], version: "1.0.0" },
      run: { model: FITNESS, sourceFiles: [FITNESS] },
      says: /the selection is not closed/,
    },
    {
      label: "a node with no package",
      opts: { name: "shared", include: ["**"], version: "1.0.0" },
      run: { model: join(FIXTURE_DIR, "packaged-shape.json"), sourceFiles: [join(FIXTURE_DIR, "packaged-shape.json")] },
      says: /has no package/,
    },
  ];
  for (const r of REFUSALS) {
    test(`refused the same way: ${r.label}`, async () => {
      const a = await both(r.opts, r.run);
      expect("threw" in a ? a.threw : "").toMatch(r.says);
    });
  }

  test("a model that cannot be published says so before a missing version does, in both", async () => {
    // No `version`, and the selection is not closed. The version is resolved after the
    // selection has passed, so the refusal is the selection's whether or not a package.json
    // happens to sit above the temp directory.
    const a = await both(
      { name: "shared", include: ["fitness::**"], exclude: ["fitness::Program"] },
      { model: FITNESS, sourceFiles: [FITNESS] },
    );
    expect("threw" in a ? a.threw : "").toMatch(/the selection is not closed/);
  });

  test("the same generator: its name, its target, and no filter of its own", () => {
    for (const make of [builtinSharedModel, refSharedModel]) {
      const plain = make({ name: "shared", include: ["**"] });
      expect(plain.name).toBe("shared-model");
      expect(plain.target).toBeUndefined();
      expect(plain.filter).toBeUndefined();
      expect(make({ name: "shared", include: ["**"], target: "published" }).target).toBe("published");
    }
  });
});

// `docs` and `api-docs` link to each other, from facts the runner reads off the generators a
// target declares (`ctx.docs`, docs-run.ts). The pair is compared with `.generate(ctx)` and
// those facts varied directly, so every combination is reached without a run per case: the
// reference writes what the built-in writes, the facts and the factory options agree, and the
// markers the runner reads are the same on both.
describe("ADR-0034 Amendments 7 and 9 — the docs and api-docs references write the same pages from the same facts", () => {
  interface Corpus { label: string; files: string[]; projectRoot?: string }
  const CORPORA: Corpus[] = [
    ...FIXTURES.map((f) => ({ label: f, files: [join(FIXTURE_DIR, f)] })),
    {
      label: "persistence-conformance fitness corpus (reports, projections, a responding prompt)",
      files: [join(REPO_FIXTURES, "persistence-conformance", "canonical", "meta.fitness.json")],
    },
    {
      label: "template-output-render corpus (documents and emails, with their template sources)",
      files: [join(REPO_FIXTURES, "template-output-render-conformance", "meta.json")],
      // Read-only here: the template page shows the Mustache source, read from `templates/`.
      projectRoot: join(REPO_FIXTURES, "template-output-render-conformance"),
    },
  ];
  const LAYOUTS: OutputLayout[] = ["flat", "package"];
  const API_SURFACES = [
    { label: "TypeScript", subDir: "api" },
    { label: "Java", subDir: "api/java", baseUrl: "https://docs.example.test/java/" },
  ];
  /** The facts of a target holding the model pages and no api pages. */
  const NO_API: DocsRunFacts = { apiSurfaces: [], modelPages: true };
  /** The facts of a target holding both. */
  const BOTH: DocsRunFacts = { apiSurfaces: [{ label: "TypeScript", subDir: "api" }], modelPages: true };

  /** The context the runner builds for a docs generator, with the facts given directly. */
  function doorCtx(
    root: Awaited<ReturnType<typeof loadFiles>>,
    generator: Generator,
    layout: OutputLayout,
    door: DocsRunFacts | undefined,
    run: { projectRoot?: string; includeHonoRoutes?: boolean; apiPrefix?: string } = {},
  ): GenContext {
    return {
      entities: root.objects(),
      loadedRoot: root,
      matches: generator.filter ?? (() => true),
      config: {
        outDir: "/docs-out",
        extStyle: "none",
        dbImport: "",
        dialect: "sqlite",
        outputLayout: layout,
        ...(run.includeHonoRoutes !== undefined ? { includeHonoRoutes: run.includeHonoRoutes } : {}),
      },
      ...(door !== undefined ? { docs: door } : {}),
      renderContext: makeRenderContext({
        dialect: "sqlite",
        loadedRoot: root,
        outDir: "/docs-out",
        dbImport: "",
        apiPrefix: run.apiPrefix ?? "",
        pkMap: buildPkMap(root),
        relationMap: buildRelationMap(root),
        outputLayout: layout,
      }),
      ...(run.projectRoot !== undefined ? { projectRoot: run.projectRoot } : {}),
      warn: () => {},
    };
  }

  function emit(
    root: Awaited<ReturnType<typeof loadFiles>>,
    generator: Generator,
    layout: OutputLayout,
    door: DocsRunFacts | undefined,
    run?: Parameters<typeof doorCtx>[4],
  ): Promise<Outcome> {
    return outcomeOf(async () =>
      (await generator.generate(doorCtx(root, generator, layout, door, run))).map((f): [string, string] => [f.path, f.content]),
    );
  }

  for (const corpus of CORPORA) {
    for (const layout of LAYOUTS) {
      test(`model pages — ${corpus.label}, ${layout} layout`, async () => {
        const root = await loadFiles(corpus.files);
        const run = corpus.projectRoot !== undefined ? { projectRoot: corpus.projectRoot } : {};
        // With no api surface beside it, and with two (one in the tree, one federated).
        for (const door of [NO_API, { ...NO_API, apiSurfaces: API_SURFACES }] satisfies DocsRunFacts[]) {
          const a = await emit(root, builtinDocs(), layout, door, run);
          const b = await emit(root, refDocs(), layout, door, run);
          expect(b).toEqual(a);
          // Vacuity guard: the overview page first, then a page per node. A flat layout
          // over a model with one short name in two packages is REFUSED, by both.
          if ("files" in a) {
            expect(a.files[0]?.[0]).toBe("README.md");
            expect(a.files.length).toBeGreaterThan(1);
          } else {
            expect(a.threw).toMatch(/duplicate output path/);
          }
        }
      });

      test(`api pages — ${corpus.label}, ${layout} layout`, async () => {
        const root = await loadFiles(corpus.files);
        const run = corpus.projectRoot !== undefined ? { projectRoot: corpus.projectRoot } : {};
        const cases: Array<{ opts?: { subDir?: string; modelBaseUrl?: string }; door: DocsRunFacts | undefined; run: Parameters<typeof doorCtx>[4] }> = [
          { door: BOTH, run },
          { opts: { subDir: "reference/ts" }, door: { apiSurfaces: [], modelPages: false }, run },
          { opts: { modelBaseUrl: "https://docs.example.test/model/" }, door: { apiSurfaces: [], modelPages: false }, run },
          { door: BOTH, run: { ...run, includeHonoRoutes: true, apiPrefix: "/api" } },
          // No facts at all: a direct call, in the default directory, in both.
          { door: undefined, run },
        ];
        for (const { opts, door, run: doorRun } of cases) {
          const a = await emit(root, builtinApiDocs(opts), layout, door, doorRun);
          const b = await emit(root, refApiDocs(opts), layout, door, doorRun);
          expect(b).toEqual(a);
          if ("files" in a) {
            const dir = opts?.subDir ?? "api";
            expect(a.files.slice(0, 2).map(([p]) => p)).toEqual([`${dir}/README.md`, `${dir}/AGENT-API.md`]);
            expect(a.files.length).toBeGreaterThan(2);
          } else {
            expect(a.threw).toMatch(/duplicate output path/);
          }
        }
      });
    }
  }

  test("the corpora reach the branches: a report page, a template page, a served report's api page, a Hono route", async () => {
    const fitness = await loadFiles(CORPORA.find((c) => c.label.startsWith("persistence"))!.files);
    const model = await emit(fitness, refDocs(), "flat", { ...NO_API, apiSurfaces: API_SURFACES });
    const readme = "files" in model ? model.files[0]![1] : "";
    // The diagrams are the model pages': the whole model on the overview page, and one
    // entity's neighbourhood on its own page. (The standalone `mermaid-er` generator that
    // also drew the first one was removed in 1.1.)
    expect(readme).toContain("## Diagram\n\n```mermaid\nerDiagram\n");
    const week = ("files" in model ? model.files : []).find(([p]) => p === "Week.md")?.[1] ?? "";
    expect(week).toContain("```mermaid\nflowchart TB\n");
    expect(readme).toContain("## Reports");
    expect(readme).toContain("## Templates");
    expect(readme).toContain("## API reference");
    expect(readme).toContain("https://docs.example.test/java/README.md");
    const api = await emit(fitness, refApiDocs(), "flat", BOTH, { includeHonoRoutes: true, apiPrefix: "/api" });
    const pages = "files" in api ? new Map(api.files) : new Map<string, string>();
    expect(pages.has("api/ProgramRoster.md")).toBe(true);
    expect([...pages.values()].some((c) => c.includes("hono"))).toBe(true);
    expect([...pages.values()].some((c) => c.includes("/api/"))).toBe(true);
  });

  test("the `filter` option narrows the object pages, in both", async () => {
    const root = await loadFiles([join(FIXTURE_DIR, "two-entities-fk.json")]);
    const only = (e: { name: string }) => e.name === "User";
    const a = await emit(root, builtinDocs({ filter: only }), "flat", NO_API);
    const b = await emit(root, refDocs({ filter: only }), "flat", NO_API);
    expect(paths(a)).toEqual(["README.md", "User.md"]);
    expect(b).toEqual(a);
  });

  // The facts and the factory options say the same thing: a page set linked by the runner is
  // the page set the options would have written, so a project can state either.
  test("the facts and the options agree, and the options win when both are given", async () => {
    const corpus = CORPORA.find((c) => c.label.startsWith("persistence"))!;
    const root = await loadFiles(corpus.files);
    for (const layout of LAYOUTS) {
      for (const make of [builtinDocs, refDocs]) {
        const viaOptions = await emit(root, make({ apiSurfaces: API_SURFACES }), layout, undefined);
        const viaFacts = await emit(root, make(), layout, { ...NO_API, apiSurfaces: API_SURFACES });
        expect(paths(viaFacts).length).toBeGreaterThan(1);
        expect(viaFacts).toEqual(viaOptions);
        expect(await emit(root, make({ apiSurfaces: API_SURFACES }), layout, NO_API)).toEqual(viaOptions);
        expect(await emit(root, make(), layout, NO_API)).toEqual(await emit(root, make(), layout, undefined));
      }
      for (const make of [builtinApiDocs, refApiDocs]) {
        for (const modelPages of [true, false]) {
          const viaOptions = await emit(root, make({ modelSurface: modelPages }), layout, undefined);
          const viaFacts = await emit(root, make(), layout, { apiSurfaces: [], modelPages });
          expect(paths(viaFacts).length).toBeGreaterThan(2);
          expect(viaFacts).toEqual(viaOptions);
        }
      }
    }
  });

  test("the markers the runner reads, and the target, are the same on the references and the built-ins", () => {
    for (const name of REFERENCE_GENERATOR_NAMES) {
      const ref = PAIRS[name].ref();
      const builtin = PAIRS[name].builtin();
      const facts = (g: Generator) => JSON.stringify({
        name: g.name, target: g.target, emitsModelDocs: g.emitsModelDocs, emitsApiDocs: g.emitsApiDocs,
      });
      expect(facts(ref), name).toBe(facts(builtin));
    }
    expect(refDocs().emitsModelDocs).toBe(true);
    expect(refApiDocs({ subDir: "reference/ts/" }).emitsApiDocs).toEqual({ subDir: "reference/ts" });
    for (const make of [refDocs, refApiDocs, refRequirements, refAgentDocs, refMetamodelDocs]) {
      expect(make().target).toBe("docs");
      expect(make({ target: "site" }).target).toBe("site");
    }
  });
});

// `requirements` and `agent-docs`, compared with `.generate(ctx)` and the run's facts given
// directly. For `agent-docs` those facts carry the physical schema, which `meta gen` computes
// (codegen-ts owns none of it), so the corpus is also run with a real one built by the same
// migrate-ts calls the command makes.
describe("ADR-0034 Amendments 8 and 9 — the requirements and agent-docs references write the same pages", () => {
  const REQUIREMENT_CORPORA: Array<{ label: string; files: string[]; ledger: boolean }> = [
    {
      label: "requirement-test-identity worked example (a ledger)",
      ledger: true,
      files: readdirSync(join(REPO_FIXTURES, "requirement-test-identity-conformance", "worked-example", "input"))
        .sort()
        .map((f) => join(REPO_FIXTURES, "requirement-test-identity-conformance", "worked-example", "input", f)),
    },
    {
      label: "persistence-conformance fitness corpus (reports, projections, a UI-less model)",
      ledger: false,
      files: [join(REPO_FIXTURES, "persistence-conformance", "canonical", "meta.fitness.json")],
    },
    { label: "trainer-website-shape (no ledger)", ledger: false, files: [join(FIXTURE_DIR, "trainer-website-shape.json")] },
  ];

  /** The agent pages' schema, built as `meta gen` builds it (cli/src/lib/agent-schema.ts). */
  function schemaFor(root: Awaited<ReturnType<typeof loadFiles>>): AgentSchemaInput {
    const dialect = "postgres" as const;
    const built = buildExpectedSchemaWithProvenance(root, {
      dialect,
      columnNamingStrategy: "snake_case",
      views: buildProjectionViews(root, { dialect, columnNamingStrategy: "snake_case" }),
    });
    return {
      dialect,
      tables: built.snapshot.tables,
      views: built.snapshot.views,
      provenance: built.provenance,
      columnType: (c: SchemaColumnLike) => columnTypeSql(c as never, dialect),
      qualify: qualifiedDbName,
    };
  }

  function ctxFor(
    root: Awaited<ReturnType<typeof loadFiles>>,
    generator: Generator,
    door: DocsRunFacts | undefined,
    includeUiTier: boolean,
  ): GenContext {
    return {
      entities: root.objects(),
      loadedRoot: root,
      matches: generator.filter ?? (() => true),
      config: { outDir: "/docs-out", extStyle: "none", dbImport: "", dialect: "postgres", includeUiTier } as never,
      ...(door !== undefined ? { docs: door } : {}),
      renderContext: makeRenderContext({
        dialect: "postgres",
        loadedRoot: root,
        outDir: "/docs-out",
        dbImport: "",
        apiPrefix: "/api",
        pkMap: buildPkMap(root),
        relationMap: buildRelationMap(root),
      }),
      warn: () => {},
    };
  }

  const run = (root: Awaited<ReturnType<typeof loadFiles>>, g: Generator, door?: DocsRunFacts, ui = true) =>
    outcomeOf(async () =>
      (await g.generate(ctxFor(root, g, door, ui))).map((f): [string, string] => [f.path, f.content]));

  for (const corpus of REQUIREMENT_CORPORA) {
    test(`requirements — ${corpus.label}`, async () => {
      const root = await loadFiles(corpus.files);
      const a = await run(root, builtinRequirements());
      const b = await run(root, refRequirements());
      expect(b).toEqual(a);
      // A ledger writes both forms; no ledger writes none — and the copy keeps that.
      expect(paths(a)).toEqual(corpus.ledger ? ["requirements.md", "requirements.toon"] : []);
      // The options an owned copy keeps: a directory and a target.
      expect(await run(root, refRequirements({ outDir: "ledger/" }))).toEqual(
        await run(root, builtinRequirements({ outDir: "ledger/" })),
      );
    });

    test(`agent-docs — ${corpus.label}`, async () => {
      const root = await loadFiles(corpus.files);
      const schema = schemaFor(root);
      const strategy = "snake_case" as const;
      for (const ui of [true, false]) {
        // Through the run's facts, through the factory's options, and with no schema at all.
        const door: DocsRunFacts = { apiSurfaces: [], modelPages: false, agentSchema: () => schema };
        const viaDoor = await run(root, builtinAgentDocs(), door, ui);
        expect(await run(root, refAgentDocs(), door, ui)).toEqual(viaDoor);
        const viaOptions = await run(root, builtinAgentDocs({ schema, columnNamingStrategy: strategy }), undefined, ui);
        expect(viaDoor).toEqual(viaOptions);
        expect(await run(root, refAgentDocs({ schema, columnNamingStrategy: strategy }), undefined, ui)).toEqual(viaOptions);
        expect(await run(root, refAgentDocs(), undefined, ui)).toEqual(await run(root, builtinAgentDocs(), undefined, ui));
        // The options win over the run's facts in both: a direct caller states what it means.
        expect(await run(root, refAgentDocs({ subDir: "for-agents" }), door, ui)).toEqual(
          await run(root, builtinAgentDocs({ subDir: "for-agents" }), door, ui),
        );
      }
      // Vacuity: the schema page is written when a schema is given, the requirements page
      // when there is a ledger, the UI page when the run emits a UI tier.
      const full = await run(root, refAgentDocs(), { apiSurfaces: [], modelPages: false, agentSchema: () => schema }, true);
      const written = paths(full);
      if (corpus.label.includes("fitness")) expect(written).toContain("agent/schema.md");
      expect(written.includes("agent/requirements.md")).toBe(corpus.ledger);
    });
  }

  test("metamodel-docs — the same pages, under the directory asked for", async () => {
    const root = await loadFiles([join(FIXTURE_DIR, "single-entity.json")]);
    for (const opts of [undefined, { subDir: "" }, { subDir: "reference/metamodel/" }]) {
      const a = await run(root, builtinMetamodelDocs(opts));
      expect(await run(root, refMetamodelDocs(opts))).toEqual(a);
      expect(paths(a)).toContain(`${opts?.subDir === "" ? "" : `${(opts?.subDir ?? "metamodel").replace(/\/$/, "")}/`}INDEX.md`);
    }
  });
});
