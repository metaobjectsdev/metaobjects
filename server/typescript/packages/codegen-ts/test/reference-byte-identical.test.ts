// ADR-0034 verification: the copyable reference templates (src/reference/*.ts) must
// produce BYTE-IDENTICAL output to the built-in generators they were relocated from.
// The reference generators import only "@metaobjectsdev/codegen-ts" (the public engine);
// if this passes, a consumer can copy them out and own them with no behavior change.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, cpSync } from "node:fs";
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
import { requirementTests as builtinRequirementTests } from "../src/generators/requirement-tests.js";
import {
  requirementTests as refRequirementTests,
  renderRequirementTest as refRenderRequirementTest,
} from "../src/reference/requirement-tests.js";
import { renderRequirementTest as builtinRenderRequirementTest } from "../src/templates/requirement-test.js";
import { cubeModel as builtinCubeModel } from "../src/generators/cube-model.js";
import { cubeModel as refCubeModel } from "../src/reference/cube-model.js";
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
  "requirement-tests": { builtin: builtinRequirementTests, ref: refRequirementTests },
  // Over the entity-shaped fixtures above this emits nothing (none declares reporting
  // vocabulary), so the pair is compared over two empty sets there; the describe at the end
  // of this file runs both over models that DO, under both Cube dialects.
  "cube-model": { builtin: builtinCubeModel, ref: refCubeModel },
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

  test("the canonical fitness model, postgres: the same three cubes, byte for byte", async () => {
    const root = await loadModelFile(CANONICAL_MODEL);
    const a = await outcome(builtinCubeModel, root, CANONICAL_CONFIG);
    const b = await outcome(refCubeModel, root, CANONICAL_CONFIG);
    // A gate over an empty emit passes trivially.
    expect("tree" in a ? a.tree.map(([p]) => p) : a).toEqual([
      "model/cubes/Asset.yml", "model/cubes/Program.yml", "model/cubes/Week.yml",
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

  test("a run that names an entity writes the same subset: its cube and the cubes it reaches", async () => {
    const run = (make: () => Generator) => runTree(make, { entityFilter: ["Week"] }, { dialect: "postgres" });
    const a = await run(builtinCubeModel);
    // Narrower than the full run, and not empty.
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThan(3);
    expect(await run(refCubeModel)).toEqual(a);
  });

  test("the dialect option beats a sqlite config, and a filter narrows the BUILD, in both", async () => {
    // Week is filtered out. Program.yml's `title` dimension exists only because Week's @via reads
    // it, so a copy that built the whole model and merely hid Week's file would still write it.
    const opts = { dialect: "mysql", filter: (o: { name: string }) => o.name !== "Week" } as const;
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

  test("the defaults: the name, no target, no filter, and a cleanup that claims only model/cubes/*.yml", () => {
    const builtin = shape(builtinCubeModel());
    // The built-in's shape written out, so the comparison cannot pass by both being wrong.
    expect(builtin).toEqual({
      name: "cube-model",
      target: undefined,
      filtered: false,
      reconciles: true,
      force: undefined,
      owns: ["model/cubes/Week.yml", "model/cubes/Match_fkHome.yml"],
    });
    expect(shape(refCubeModel())).toEqual(builtin);
  });

  test("the target and the filter are the application's, and the namespace does not move with them", () => {
    const opts = { target: "analytics", filter: () => true } as const;
    const builtin = shape(builtinCubeModel(opts));
    expect(builtin.target).toBe("analytics");
    expect(builtin.filtered).toBe(true);
    expect(builtin.owns).toEqual(["model/cubes/Week.yml", "model/cubes/Match_fkHome.yml"]);
    expect(shape(refCubeModel(opts))).toEqual(builtin);
  });
});
