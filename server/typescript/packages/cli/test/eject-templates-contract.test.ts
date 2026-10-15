// ADR-0034 Amendment 8 — an ejected TypeScript generator owns ALL of the code that writes
// its output, for every generator in the catalog.
//
// Driven by the catalog, not by a list: the generators are whatever `listCatalog()` holds,
// and the one exemption is the one the maintainer ruled (`template`, the Mustache primitive,
// which has no emit logic of its own). Each ejectable generator is ejected ALONE, by the real
// `meta eject`, into an empty project, and then:
//
//   depth      nothing the project holds imports a module of the codegen packages that is
//              not the engine. Read through the compiler, so a re-export, a type-only import
//              and an `import * as` count as the module that declares the name.
//   compiles   every owned file typechecks the way the adopter's own `tsconfig.codegen.json`
//              would check it. A specifier left pointing into the package, or an engine name
//              the package entry does not export, is a TS2307 / TS2305 here.
//   emits      the owned generator, loaded from the project, writes byte for byte what the
//              packaged generator writes, over models that make every generator emit.
//
// The last is what makes a copied module a hand-over rather than a fork: the copy has to BE
// the code that was running.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  buildPkMap, buildRelationMap, buildProjectionViews, defineConfig, HTTP_RUNTIME_PACKAGE,
  makeRenderContext, runGen,
} from "@metaobjectsdev/codegen-ts";
import { ENGINE_MODULES } from "@metaobjectsdev/codegen-ts/engine";
import type { AgentSchemaInput, DocsRunFacts, GenContext, Generator, SchemaColumnLike } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { buildExpectedSchemaWithProvenance, columnTypeSql, qualifiedDbName } from "@metaobjectsdev/migrate-ts";
import { factoryModuleOf, listCatalog } from "../src/lib/catalog.js";
import { ejectGenerator } from "../src/commands/eject.js";

const PACKAGES = resolve(import.meta.dirname, "..", "..");
const FIXTURES = resolve(PACKAGES, "..", "..", "..", "fixtures");
/** Inside the workspace, so an ejected generator resolves `@metaobjectsdev/*` as a project's does. */
const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");
const ENGINE = new Set(ENGINE_MODULES);
const CODEGEN_DIRS = ["codegen-ts", "codegen-ts-react", "codegen-ts-tanstack"];

const catalog = listCatalog();
const ejectable = catalog.filter((e) => e.ejectable);

/** The tsconfig `meta init` scaffolds for the owned tier (`tsconfig.codegen.json`), plus what the workspace needs. */
const ADOPTER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  // The condition Bun resolves the workspace packages by: source, not a built `dist/`.
  customConditions: ["bun"],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: ["bun-types"],
};

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => join(f.parentPath, f.name))
    .sort();
}

interface Owned {
  name: string;
  root: string;
  /** The generator and its template modules, absolute. The adapter copy under `codegen/runtime/` is not one of them. */
  files: string[];
  generatorPath: string;
}

describe("eject contract (typescript) — completeness", () => {
  test("every catalog entry is ejectable except the two the maintainer exempted", () => {
    // Derived, so a generator added to any registry is ejectable or the test names it. The
    // exemption is `template`: the Mustache primitive, whose emit logic is the template and
    // the walk the adopter supplies (ADR-0034 Amendment 8, ruling 5).
    // `docs-site` too (ADR-0034 Amendment 9): its builder is engine, and `meta eject docs-site`
    // copies the site's templates and assets, which is what an adopter changes.
    expect(catalog.filter((e) => !e.ejectable).map((e) => e.name)).toEqual(["docs-site", "template"]);
    expect(ejectable.length).toBeGreaterThanOrEqual(24);
  });
});

describe("eject contract (typescript) — an owned generator owns what writes its output", () => {
  const owned = new Map<string, Owned>();
  let program: ts.Program;

  beforeAll(async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    for (const entry of ejectable) {
      const root = mkdtempSync(join(WORKSPACE_TMP, "eject-templates-"));
      const result = await ejectGenerator({ cwd: root, name: entry.name });
      owned.set(entry.name, {
        name: entry.name,
        root,
        files: [
          ...filesUnder(join(root, "codegen", "generators")),
          ...filesUnder(join(root, "codegen", "templates")),
        ],
        generatorPath: join(root, result.path),
      });
    }
    // One program over every project: a file imports only what is relative to it, so each
    // project is still checked alone, and the package sources are parsed once.
    program = ts.createProgram({ rootNames: [...owned.values()].flatMap((o) => o.files), options: ADOPTER_OPTIONS });
  }, 120_000);

  afterAll(() => {
    for (const { root } of owned.values()) rmSync(root, { recursive: true, force: true });
  });

  /** The modules of the codegen packages that `files` reach and that are not the engine. */
  function outsideEngine(files: readonly string[]): string[] {
    const checker = program.getTypeChecker();
    const outside = new Set<string>();
    const recordFile = (fileName: string): void => {
      const module = relative(PACKAGES, fileName).split("\\").join("/");
      const inCodegen = CODEGEN_DIRS.some((d) => module.startsWith(`${d}/src/`));
      if (inCodegen && !ENGINE.has(module)) outside.add(module);
    };
    const record = (symbol: ts.Symbol | undefined): void => {
      if (symbol === undefined) return;
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      for (const declaration of target.declarations ?? []) recordFile(declaration.getSourceFile().fileName);
    };
    const isPackage = (specifier: ts.Node | undefined): specifier is ts.StringLiteral =>
      specifier !== undefined && ts.isStringLiteral(specifier) && !specifier.text.startsWith(".");
    const recordAll = (specifier: ts.StringLiteral): void => {
      const module = checker.getSymbolAtLocation(specifier);
      if (module !== undefined) for (const exported of checker.getExportsOfModule(module)) record(exported);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && isPackage(node.moduleSpecifier)) {
        const clause = node.importClause;
        if (clause?.name !== undefined) record(checker.getSymbolAtLocation(clause.name));
        const bindings = clause?.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) recordAll(node.moduleSpecifier);
        else if (bindings !== undefined) for (const e of bindings.elements) record(checker.getSymbolAtLocation(e.name));
      } else if (ts.isExportDeclaration(node) && isPackage(node.moduleSpecifier)) {
        const clause = node.exportClause;
        if (clause !== undefined && ts.isNamedExports(clause)) {
          for (const e of clause.elements) record(checker.getSymbolAtLocation(e.name));
        } else recordAll(node.moduleSpecifier);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isPackage(node.argument.literal)) {
        const named = node.qualifier === undefined ? undefined : checker.getSymbolAtLocation(node.qualifier);
        if (named !== undefined) record(named);
        else recordAll(node.argument.literal);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = node.arguments[0];
        if (isPackage(specifier)) {
          const module = checker.getSymbolAtLocation(specifier);
          for (const declaration of module?.declarations ?? []) recordFile(declaration.getSourceFile().fileName);
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const file of files) visit(program.getSourceFile(file)!);
    return [...outside].sort();
  }

  test("the scan counts a re-exported name, a namespace import and a type-only import", () => {
    // The assertion below rests on this scan, so it is held to a file whose answer is known.
    const dir = mkdtempSync(join(WORKSPACE_TMP, "eject-templates-probe-"));
    try {
      const probe = join(dir, "probe.ts");
      writeFileSync(
        probe,
        [
          // `renderEntityFile` is exported by the package entry and DECLARED in a template module.
          'import { renderEntityFile } from "@metaobjectsdev/codegen-ts";',
          'import type { RenderEntityFileOpts } from "@metaobjectsdev/codegen-ts";',
          // `formatTs` is engine: it must not be counted.
          'import { formatTs } from "@metaobjectsdev/codegen-ts";',
          "export const keep = [renderEntityFile, formatTs];",
          "export type Opts = RenderEntityFileOpts;",
          "",
        ].join("\n"),
      );
      const probed = ts.createProgram({ rootNames: [probe], options: ADOPTER_OPTIONS });
      const saved = program;
      program = probed;
      try {
        expect(outsideEngine([probe])).toEqual(["codegen-ts/src/templates/entity-file.ts"]);
      } finally {
        program = saved;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("depth: no owned file imports a module that writes output, outside the engine", () => {
    const problems: string[] = [];
    for (const [name, copy] of owned) {
      const reached = outsideEngine(copy.files);
      if (reached.length > 0) problems.push(`${name}: ${reached.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  test("compiles: every owned file typechecks as an adopter's tsconfig.codegen.json checks it", () => {
    const diagnostics: string[] = [];
    for (const { files } of owned.values()) {
      for (const file of files) {
        const sf = program.getSourceFile(file)!;
        for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
          diagnostics.push(
            `${relative(WORKSPACE_TMP, file)}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
          );
        }
      }
    }
    // The same file is checked under each project it was copied into; one report each.
    expect([...new Set(diagnostics.map((d) => d.replace(/^eject-templates-\w+\//, "")))]).toEqual([]);
  }, 120_000);

  test("what a copy imports from outside the project is the packages and nothing else", () => {
    const ALLOWED = new Set(["@metaobjectsdev/codegen-ts", "@metaobjectsdev/codegen-ts-react", "@metaobjectsdev/codegen-ts-tanstack",
      "@metaobjectsdev/metadata", "@metaobjectsdev/render", "@toon-format/toon"]);
    const found = new Set<string>();
    for (const { files } of owned.values()) {
      for (const file of files) {
        const sf = program.getSourceFile(file)!;
        for (const statement of sf.statements) {
          if (
            (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
            statement.moduleSpecifier !== undefined &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            !statement.moduleSpecifier.text.startsWith(".") &&
            !statement.moduleSpecifier.text.startsWith("node:")
          ) {
            const spec = statement.moduleSpecifier.text;
            found.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
          }
        }
      }
    }
    // ts-poet is gone from the list on purpose: a copy builds `Code` with the engine's own.
    expect([...found].filter((p) => !ALLOWED.has(p))).toEqual([]);
    expect(found.has("ts-poet")).toBe(false);
  });

  test("each generator's copy count is stable: the closure is what the registry says it is", () => {
    // `barrel` and `requirement-tests` call no template module (the latter renders its own
    // stub and takes only types from the engine), nor does `metamodel-docs` (its pages are
    // rendered by the metamodel package, which is core); every other generator calls one.
    const callsNone = new Set(["barrel", "requirement-tests", "metamodel-docs"]);
    for (const [name, copy] of owned) {
      const templates = copy.files.filter((f) => f.includes(`${join("codegen", "templates")}`));
      expect(templates.length > 0, name).toBe(!callsNone.has(name));
    }
  });
});

// ---------------------------------------------------------------------------------------
// emits
// ---------------------------------------------------------------------------------------

interface Corpus {
  label: string;
  files: string[];
  /** Copied to `<project>/templates`, where render-helper's gen-time drift gate reads. */
  templates?: string;
}

function inputs(...segments: string[]): string[] {
  const dir = join(FIXTURES, ...segments);
  return readdirSync(dir).sort().map((f) => join(dir, f));
}

/** Shared models that between them make every ejectable generator emit. */
const CORPORA: Corpus[] = [
  { label: "fitness", files: [join(FIXTURES, "persistence-conformance", "canonical", "meta.fitness.json")] },
  {
    label: "template-output",
    files: [join(FIXTURES, "template-output-render-conformance", "meta.json")],
    templates: join(FIXTURES, "template-output-render-conformance", "templates"),
  },
  { label: "requirements", files: inputs("requirement-test-identity-conformance", "worked-example", "input") },
  { label: "stored-proc", files: inputs("conformance", "parameter-ref-on-stored-proc", "input") },
  // The grid tier is TypeScript-only, so its model is this port's own fixture.
  { label: "data-grid", files: [join(PACKAGES, "codegen-ts-tanstack", "test", "fixtures", "single-entity.json")] },
  { label: "llm-call", files: inputs("conformance", "ai-trace-prompt-nested", "input") },
];

/** The options a factory cannot be called without. `shared-model` publishes nothing until told what to include. */
const REQUIRED_OPTIONS: Record<string, unknown> = {
  "shared-model": { name: "shared", include: ["**"], version: "1.0.0" },
};
/**
 * The three owned generators whose OUTPUT imports the HTTP adapter default to the copy
 * `meta eject` places under `codegen/runtime/`. The packaged ones import the package, so the
 * comparison binds the owned ones to it through the option that exists for the choice; what
 * is compared is the composition. (The local-copy spelling is gated by runtime-eject.test.ts.)
 */
const OWNED_OPTIONS: Record<string, unknown> = {
  entity: { runtimeImport: HTTP_RUNTIME_PACKAGE },
  routes: { runtimeImport: HTTP_RUNTIME_PACKAGE },
  "routes-hono": { runtimeImport: HTTP_RUNTIME_PACKAGE },
};

type Factory = (opts?: unknown) => Generator;
function build(factory: Factory, name: string, owned: boolean): Generator {
  const options = { ...(REQUIRED_OPTIONS[name] as object | undefined), ...(owned ? (OWNED_OPTIONS[name] as object | undefined) : undefined) };
  return Object.keys(options).length > 0 ? factory(options) : factory();
}

/** The key a refusal is recorded under, in place of the files a run would have written. */
const REFUSED = "<refused>";

/** What `meta gen` computes for the agent pages and codegen-ts owns none of (cli/src/lib/agent-schema.ts). */
function agentSchema(root: Awaited<ReturnType<MetaDataLoader["load"]>>["root"]): AgentSchemaInput | undefined {
  const dialect = "postgres" as const;
  try {
    const built = buildExpectedSchemaWithProvenance(root, {
      dialect,
      views: buildProjectionViews(root, { dialect }),
    });
    return {
      dialect,
      tables: built.snapshot.tables,
      views: built.snapshot.views,
      provenance: built.provenance,
      columnType: (c: SchemaColumnLike) => columnTypeSql(c as never, dialect),
      qualify: qualifiedDbName,
    };
  } catch {
    return undefined;
  }
}

/** Run one generator over one corpus; the files it wrote. */
async function emit(
  generator: Generator,
  docs: boolean,
  corpus: Corpus,
  projectRoot: string,
  outDir: string,
): Promise<Record<string, string>> {
  const loaded = await new MetaDataLoader().load(corpus.files.map((f) => new FileSource(f)));
  expect(loaded.errors, corpus.label).toEqual([]);
  const settings = { outDir, extStyle: "none", dbImport: "../db", dialect: "postgres" } as const;
  if (docs) {
    // A documentation generator, run with `.generate(ctx)` and every fact the runner can hand
    // it on (`ctx.docs`): model and api pages beside each other, the agent schema, the UI
    // tier on. That reaches each branch the cross-links and the schema page take, which a
    // run of the generator alone would not.
    const facts: DocsRunFacts = {
      apiSurfaces: [{ label: "TypeScript", subDir: "api" }],
      modelPages: true,
      agentSchema: () => agentSchema(loaded.root),
    };
    const ctx: GenContext = {
      entities: loaded.root.objects(),
      loadedRoot: loaded.root,
      matches: generator.filter ?? (() => true),
      config: { ...settings, includeUiTier: true } as never,
      docs: facts,
      renderContext: makeRenderContext({
        dialect: "postgres",
        loadedRoot: loaded.root,
        outDir,
        dbImport: "../db",
        apiPrefix: "/api",
        pkMap: buildPkMap(loaded.root),
        relationMap: buildRelationMap(loaded.root),
      }),
      projectRoot,
      warn: () => {},
    };
    try {
      return Object.fromEntries((await generator.generate(ctx)).map((f) => [f.path, f.content]));
    } catch (e) {
      return { [REFUSED]: e instanceof Error ? e.message : String(e) };
    }
  }
  try {
    await runGen({
      config: defineConfig({ ...settings, generators: [generator] }),
      metadata: loaded.root,
      projectRoot,
      sourceFiles: corpus.files,
    });
  } catch (e) {
    // A generator may refuse a model (`shared-model` re-reads the source files strictly). The
    // refusal is then what the two sides are compared on: the same words, or a failure.
    return { [REFUSED]: e instanceof Error ? e.message : String(e) };
  }
  const out: Record<string, string> = {};
  for (const file of filesUnder(outDir)) out[relative(outDir, file)] = readFileSync(file, "utf8");
  return out;
}

describe("eject contract (typescript) — an owned copy emits what the packaged generator emits", () => {
  const roots = new Map<string, { root: string; generatorPath: string }>();

  beforeAll(async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    for (const entry of ejectable) {
      const root = mkdtempSync(join(WORKSPACE_TMP, "eject-emits-"));
      const result = await ejectGenerator({ cwd: root, name: entry.name });
      roots.set(entry.name, { root, generatorPath: join(root, result.path) });
    }
  }, 120_000);

  afterAll(() => {
    for (const { root } of roots.values()) rmSync(root, { recursive: true, force: true });
  });

  for (const entry of ejectable) {
    test(`${entry.name}: loaded from the project, over every corpus`, async () => {
      const copy = roots.get(entry.name)!;
      const module = (await import(copy.generatorPath)) as Record<string, unknown>;
      const factory = module[entry.factoryExport];
      expect(typeof factory, `${copy.generatorPath} exports ${entry.factoryExport}`).toBe("function");
      // The packaged side is the factory an adopter imports, by the name the catalog prints.
      const shipped = ((await import(factoryModuleOf(entry.name)!)) as Record<string, unknown>)[entry.factoryExport];
      const docs = entry.layer === "docs";

      let emitted = 0;
      for (const corpus of CORPORA) {
        if (corpus.templates !== undefined) cpSync(corpus.templates, join(copy.root, "templates"), { recursive: true });
        const packaged = await emit(
          build(shipped as Factory, entry.name, false), docs, corpus, copy.root, join(copy.root, "out", corpus.label, "packaged"));
        const mine = await emit(
          build(factory as Factory, entry.name, true), docs, corpus, copy.root, join(copy.root, "out", corpus.label, "owned"));
        rmSync(join(copy.root, "templates"), { recursive: true, force: true });
        emitted += Object.keys(packaged).filter((path) => path !== REFUSED).length;
        expect(Object.keys(mine).sort(), `${entry.name} over ${corpus.label}`).toEqual(Object.keys(packaged).sort());
        for (const [path, content] of Object.entries(packaged)) {
          expect(`${path}:\n${mine[path]}`, `${entry.name} over ${corpus.label}`).toBe(`${path}:\n${content}`);
        }
      }
      // An empty emit on both sides compares equal and proves nothing.
      expect(emitted, `${entry.name} emitted nothing over ${CORPORA.map((c) => c.label).join(", ")}`).toBeGreaterThan(0);
    }, 120_000);
  }
});
