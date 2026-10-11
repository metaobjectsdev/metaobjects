// The eject contract, asserted for the TypeScript port (ADR-0034 Amendment 8).
//
// Every stock generator can be ejected, and the owned copy holds its emit. Three
// assertions, each driven by fixtures/generator-registry-conformance/registry.json:
//
//   census        every generator factory a published codegen package exports belongs to
//                 a catalog entry, so none ships outside the catalog, `meta eject` and
//                 every gate that reads them.
//   completeness  every catalog entry ships a reference template, unless the shared file
//                 exempts it with a reason.
//   depth         each generator, ejected ALONE into an empty project by the real
//                 `meta eject`, loads; imports no VALUE from the codegen packages outside
//                 the engine surface; and emits what the packaged generator emits.
//
// Where the contract does not hold yet, the shared file's `pending` list says so. A
// pending entry that passes fails here, and so does a gap that is not listed.
//
// This lives in `cli` for the reason catalog-conformance.test.ts does: it is the only
// package that sees all three registry slices, and the only one that owns `meta eject`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  buildPkMap, buildRelationMap, defineConfig, makeRenderContext, runGen, HTTP_RUNTIME_PACKAGE, OWNED_RUNTIME_DIR,
} from "@metaobjectsdev/codegen-ts";
import type { GenContext, Generator } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { catalogPackages, factoryModuleOf, listCatalog, packageOf } from "../src/lib/catalog.js";
import { ejectGenerator } from "../src/commands/eject.js";

const PORT = "typescript";
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..", "..");
const PACKAGES = join(REPO_ROOT, "server", "typescript", "packages");
const FIXTURES = join(REPO_ROOT, "fixtures");
const MANIFEST_PATH = join(FIXTURES, "generator-registry-conformance", "registry.json");
/** Inside the workspace, so an ejected generator resolves `@metaobjectsdev/*` as a project's does. */
const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");
const CODEGEN_ENGINE = "@metaobjectsdev/codegen-ts";
/** The shared file's release switch: while true, the pending list may hold entries. */
const RELEASE_SWITCH = "PENDING_LIST_MAY_BE_NON_EMPTY";

type Assertion = "census" | "completeness" | "depth";
interface Pending { generator: string; port: string; assertion: Assertion; gap: number; outside?: string[] }
interface Manifest {
  ports: string[];
  generators: Record<string, { ports: string[]; eject: "full" | { exempt: string; ruling: string } }>;
  eject: {
    [RELEASE_SWITCH]: boolean;
    engineSurface: Record<string, { codegenPackages: string[]; engine: string[] }>;
    exemptEmitters: { name: string; port: string; path: string; exempt: string; ruling: string }[];
    pending: Pending[];
  };
}
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

/** This port's pending entries for one assertion, by generator (one entry per gap). */
function pending(assertion: Assertion): Map<string, Pending[]> {
  const out = new Map<string, Pending[]>();
  for (const p of manifest.eject.pending) {
    if (p.port !== PORT || p.assertion !== assertion) continue;
    out.set(p.generator, [...(out.get(p.generator) ?? []), p]);
  }
  return out;
}

const isExempt = (name: string): boolean => manifest.generators[name]?.eject !== "full";

/** `**` matches any run of characters, `*` one path segment. */
function glob(pattern: string): RegExp {
  const body = pattern
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

const SURFACE = manifest.eject.engineSurface[PORT]!;
const CODEGEN_PACKAGES = SURFACE.codegenPackages.map(glob);
const ENGINE = SURFACE.engine.map(glob);
/** True for a module that writes output: inside the codegen packages, not engine. */
const isOutsideEngineSurface = (module: string): boolean =>
  CODEGEN_PACKAGES.some((p) => p.test(module)) && !ENGINE.some((p) => p.test(module));

const COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  // The condition Bun resolves the workspace packages by: source, not a built `dist/`.
  customConditions: ["bun"],
  target: ts.ScriptTarget.ES2023,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
};

const catalog = listCatalog();

/** Which packages a release publishes: the repository's one definition, read not restated. */
const { publishSet } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "publish-set.mjs")).href)) as {
  publishSet: () => { set: { dir: string }[] };
};

// ---------------------------------------------------------------------------------------
// census
// ---------------------------------------------------------------------------------------

/**
 * Every exported function, in every public entry point of every PUBLISHED package that is
 * or depends on the codegen engine, whose return type is a `Generator`. Read from the
 * types, never called: `templateGenerator` and `sharedModelFile` take required options.
 */
function exportedGeneratorFactories(): Map<string, string> {
  const entryFiles: string[] = [];
  for (const { dir } of publishSet().set) {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      exports?: Record<string, string | { bun?: string }>;
    };
    const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
    if (pkg.name !== CODEGEN_ENGINE && !(CODEGEN_ENGINE in deps)) continue;
    for (const target of Object.values(pkg.exports ?? {})) {
      const source = typeof target === "string" ? target : target.bun;
      if (source?.endsWith(".ts") === true) entryFiles.push(join(REPO_ROOT, dir, source));
    }
  }
  const generatorModule = join(PACKAGES, "codegen-ts", "src", "generator.ts");
  const program = ts.createProgram({ rootNames: [...entryFiles, generatorModule], options: COMPILER_OPTIONS });
  const checker = program.getTypeChecker();
  const moduleOf = (file: string) => checker.getSymbolAtLocation(program.getSourceFile(file)!)!;
  const generatorSymbol = checker.getExportsOfModule(moduleOf(generatorModule)).find((s) => s.name === "Generator")!;
  const generatorType = checker.getDeclaredTypeOfSymbol(generatorSymbol);

  const found = new Map<string, string>();
  for (const file of entryFiles) {
    for (const exported of checker.getExportsOfModule(moduleOf(file))) {
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declaration = target.valueDeclaration;
      if (declaration === undefined) continue;
      const returnsGenerator = checker
        .getTypeOfSymbolAtLocation(target, declaration)
        .getCallSignatures()
        .some((signature) => {
          const returned = signature.getReturnType();
          return !(returned.flags & ts.TypeFlags.Any) && checker.isTypeAssignableTo(returned, generatorType);
        });
      if (returnsGenerator) found.set(exported.name, relative(PACKAGES, declaration.getSourceFile().fileName));
    }
  }
  return found;
}

describe("eject contract — census", () => {
  test("every exported generator factory belongs to a catalog entry", () => {
    const factories = exportedGeneratorFactories();
    // Vacuity guard: the scan reads types, so a resolution failure finds nothing at all.
    expect(factories.size).toBeGreaterThan(20);
    const registered = new Set(catalog.map((e) => e.factoryExport));
    const unregistered = [...factories]
      .filter(([name]) => !registered.has(name))
      .map(([name, file]) => `${name} (${file})`)
      .sort();
    expect(
      unregistered,
      "generator factories no catalog entry names, so `meta gen --list`, `meta eject` and every " +
        `gate that reads the catalog cannot see them. Register each in its package's registry and in ${MANIFEST_PATH}.`,
    ).toEqual([]);
  });

  test("the catalog exposes the names the shared file gives this port", () => {
    const expected = Object.entries(manifest.generators).filter(([, e]) => e.ports.includes(PORT)).map(([n]) => n);
    const actual = new Set(catalog.map((e) => e.name));
    const missing = expected.filter((n) => !actual.has(n)).sort();
    expect(missing, "expected in the catalog by the shared file; a pending census entry must list each").toEqual(
      [...pending("census").keys()].sort(),
    );
  });

  test("every exempt non-generator emitter names code that exists, with a reason and a ruling", () => {
    for (const emitter of manifest.eject.exemptEmitters) {
      expect(manifest.ports).toContain(emitter.port);
      expect(existsSync(join(REPO_ROOT, emitter.path)), `${emitter.name}: ${emitter.path}`).toBe(true);
      expect(emitter.exempt.trim()).not.toBe("");
      expect(emitter.ruling.trim()).not.toBe("");
    }
  });
});

// ---------------------------------------------------------------------------------------
// completeness
// ---------------------------------------------------------------------------------------

describe("eject contract — completeness", () => {
  test("every catalog entry ships a reference template unless the shared file exempts it", () => {
    const waiting = pending("completeness");
    const registered = new Set(catalog.map((e) => e.name));
    const problems: string[] = [];
    for (const entry of catalog) {
      if (isExempt(entry.name)) {
        if (entry.ejectable) problems.push(`${entry.name}: exempt in the shared file but ejectable; drop the exemption`);
        continue;
      }
      if (entry.ejectable && waiting.has(entry.name)) {
        problems.push(`${entry.name}: ejectable now; remove its pending completeness entry`);
      }
      if (!entry.ejectable && !waiting.has(entry.name)) {
        problems.push(`${entry.name}: no reference template, and the shared file does not exempt it`);
      }
    }
    for (const name of waiting.keys()) {
      if (!registered.has(name)) problems.push(`${name}: pending completeness entry for a generator the catalog does not hold`);
    }
    expect(problems).toEqual([]);
  });

  test("each package's reference directory holds exactly its ejectable generators", () => {
    // `REFERENCE_GENERATOR_NAMES` and its two siblings are hand-kept lists; this holds
    // each to the files on disk, so a template cannot ship unlisted or be listed unshipped.
    for (const pkg of catalogPackages()) {
      const dir = join(PACKAGES, pkg.slice(pkg.indexOf("/") + 1), "src", "reference");
      const onDisk = readdirSync(dir).map((f) => f.replace(/\.tsx?$/, "")).sort();
      const listed = catalog.filter((e) => e.ejectable && packageOf(e.name) === pkg).map((e) => e.name).sort();
      expect(onDisk, dir).toEqual(listed);
    }
  });
});

// ---------------------------------------------------------------------------------------
// depth
// ---------------------------------------------------------------------------------------

interface Owned {
  name: string;
  /** The empty project `meta eject <name>` ran in. */
  root: string;
  /** Every file eject wrote, absolute: the generator, and any runtime handed over with it. */
  files: string[];
  generatorPath: string;
  handsRuntimeOver: boolean;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => join(f.parentPath, f.name))
    .sort();
}

/**
 * The codegen-package modules the owned files import a VALUE from, outside the engine
 * surface. Each imported binding is resolved through any re-exporting barrel to the file
 * that declares it; a type-only import writes no output and is not counted.
 */
function outsideEngineSurface(owned: Owned): string[] {
  const sources = owned.files.filter((f) => /\.tsx?$/.test(f));
  const program = ts.createProgram({ rootNames: sources, options: COMPILER_OPTIONS });
  const checker = program.getTypeChecker();
  const outside = new Set<string>();

  const record = (symbol: ts.Symbol | undefined): void => {
    if (symbol === undefined) return;
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (!(target.flags & ts.SymbolFlags.Value)) return;
    for (const declaration of target.declarations ?? []) {
      const module = relative(PACKAGES, declaration.getSourceFile().fileName);
      if (isOutsideEngineSurface(module)) outside.add(module);
    }
  };

  for (const file of sources) {
    const source = program.getSourceFile(file)!;
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteral(specifier) || specifier.text.startsWith(".")) continue;
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        const clause = statement.exportClause;
        if (clause !== undefined && ts.isNamedExports(clause)) {
          for (const element of clause.elements) if (!element.isTypeOnly) record(checker.getSymbolAtLocation(element.name));
        } else {
          for (const exported of checker.getExportsOfModule(checker.getSymbolAtLocation(specifier)!)) record(exported);
        }
        continue;
      }
      const clause = statement.importClause;
      if (clause === undefined || clause.isTypeOnly) continue;
      if (clause.name !== undefined) record(checker.getSymbolAtLocation(clause.name));
      const bindings = clause.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings)) {
        for (const exported of checker.getExportsOfModule(checker.getSymbolAtLocation(specifier)!)) record(exported);
      } else {
        for (const element of bindings.elements) if (!element.isTypeOnly) record(checker.getSymbolAtLocation(element.name));
      }
    }
  }
  return [...outside].sort();
}

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

/**
 * The options a factory cannot be called without, given to the packaged factory and the
 * owned one alike. `shared-model` publishes nothing until it is told what to include.
 */
const FACTORY_OPTIONS: Record<string, unknown> = {
  "shared-model": { name: "shared", include: ["**"], version: "1.0.0" },
};

/** The key a refusal is recorded under, in place of the files a run would have written. */
const REFUSED = "<refused>";

type Factory = (opts?: unknown) => Generator;
const build = (factory: Factory, name: string): Generator =>
  name in FACTORY_OPTIONS ? factory(FACTORY_OPTIONS[name]) : factory();

/** Run one generator over one corpus the way its door runs it; the files it wrote. */
async function emit(
  generator: Generator,
  corpus: Corpus,
  projectRoot: string,
  outDir: string,
  throughDocsDoor: boolean,
): Promise<Record<string, string>> {
  const loaded = await new MetaDataLoader().load(corpus.files.map((f) => new FileSource(f)));
  expect(loaded.errors, corpus.label).toEqual([]);
  const settings = { outDir, extStyle: "none", dbImport: "../db", dialect: "postgres" } as const;
  if (throughDocsDoor) {
    // `meta docs` runs a docs generator, never `runGen`, which skips one: `.generate(ctx)`
    // with the generator's own `filter` as `ctx.matches`.
    const ctx: GenContext = {
      entities: loaded.root.objects(),
      loadedRoot: loaded.root,
      matches: generator.filter ?? (() => true),
      config: settings,
      renderContext: makeRenderContext({
        dialect: "postgres",
        loadedRoot: loaded.root,
        outDir,
        dbImport: "../db",
        apiPrefix: "",
        pkMap: buildPkMap(loaded.root),
        relationMap: buildRelationMap(loaded.root),
      }),
      projectRoot,
      warn: () => {},
    };
    return Object.fromEntries((await generator.generate(ctx)).map((f) => [f.path, f.content]));
  }
  try {
    await runGen({
      config: defineConfig({ ...settings, generators: [generator] }),
      metadata: loaded.root,
      projectRoot,
      sourceFiles: corpus.files,
    });
  } catch (e) {
    // A generator may refuse a model (`shared-model` re-reads the source files strictly).
    // The refusal is then what the two sides are compared on: the same words, or a failure.
    return { [REFUSED]: e instanceof Error ? e.message : String(e) };
  }
  const out: Record<string, string> = {};
  for (const file of filesUnder(outDir)) out[relative(outDir, file)] = readFileSync(file, "utf8");
  return out;
}

/**
 * The one difference an owned copy's output is allowed: it imports the HTTP adapter the
 * adopter owns in `codegen/runtime/`, where packaged output imports the package. The
 * formatter orders a package import and a relative one differently, so the import block
 * is compared as a set of statements and everything after it exactly.
 */
function adapterNeutral(source: string): string {
  const adapter = "@@ADAPTER@@";
  const moved = source
    .replace(new RegExp(`${HTTP_RUNTIME_PACKAGE}/[\\w-]+`, "g"), adapter)
    .replace(new RegExp(`(?:\\.\\./)+${OWNED_RUNTIME_DIR}/[\\w-]+/[\\w-]+`, "g"), adapter);
  const IMPORT = /^import [^;]*;\n/gm;
  return [...(moved.match(IMPORT) ?? [])].sort().join("") + moved.replace(IMPORT, "");
}

describe("eject contract — depth", () => {
  const owned = new Map<string, Owned>();

  beforeAll(async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    for (const entry of catalog) {
      if (!entry.ejectable) continue;
      const root = mkdtempSync(join(WORKSPACE_TMP, "eject-contract-"));
      const result = await ejectGenerator({ cwd: root, name: entry.name });
      owned.set(entry.name, {
        name: entry.name,
        root,
        files: filesUnder(join(root, "codegen")),
        generatorPath: join(root, result.path),
        handsRuntimeOver: (result.runtime?.files ?? []).length > 0,
      });
    }
  });

  afterAll(() => {
    for (const { root } of owned.values()) rmSync(root, { recursive: true, force: true });
  });

  test("an owned copy imports only the engine surface", () => {
    const waiting = pending("depth");
    const problems: string[] = [];
    for (const [name, copy] of owned) {
      const actual = outsideEngineSurface(copy);
      const expected = (waiting.get(name) ?? []).flatMap((p) => p.outside ?? []).sort();
      if (JSON.stringify(actual) === JSON.stringify(expected)) continue;
      if (expected.length === 0) {
        problems.push(
          `${name}: its owned copy imports emit code that stays in the package: ${actual.join(", ")}. ` +
            `Hand it over with the generator; an import of the engine belongs in eject.engineSurface.${PORT}.engine.`,
        );
      } else if (actual.length === 0) {
        problems.push(`${name}: its owned copy is whole now; remove its pending depth entry`);
      } else {
        problems.push(`${name}: pending depth entries list [${expected.join(", ")}], the owned copy imports [${actual.join(", ")}]`);
      }
    }
    for (const name of waiting.keys()) {
      if (!owned.has(name)) problems.push(`${name}: pending depth entry for a generator that is not ejectable`);
    }
    expect(problems).toEqual([]);
  }, 60_000);

  test("every engine surface entry names a real module", () => {
    const stale = SURFACE.engine.filter((m) => !m.includes("*") && !existsSync(join(PACKAGES, m)));
    expect(stale).toEqual([]);
  });

  for (const entry of catalog) {
    if (!entry.ejectable) continue;
    test(`${entry.name}: an unchanged owned copy loads alone and emits what the packaged generator emits`, async () => {
      const copy = owned.get(entry.name)!;
      const module = (await import(copy.generatorPath)) as Record<string, unknown>;
      const factory = module[entry.factoryExport];
      expect(typeof factory, `${copy.generatorPath} exports ${entry.factoryExport}`).toBe("function");
      // The packaged side is the factory an adopter imports, by the name the catalog prints.
      const shipped = ((await import(factoryModuleOf(entry.name)!)) as Record<string, unknown>)[entry.factoryExport];
      const throughDocsDoor = entry.docsSurface !== undefined;

      let emitted = 0;
      for (const corpus of CORPORA) {
        if (corpus.templates !== undefined) cpSync(corpus.templates, join(copy.root, "templates"), { recursive: true });
        // Same depth under the project root on both sides, so a relative import of the
        // owned adapter is spelled the same way in each.
        const packaged = await emit(
          build(shipped as Factory, entry.name), corpus, copy.root, join(copy.root, "out", corpus.label, "packaged"), throughDocsDoor);
        const mine = await emit(
          build(factory as Factory, entry.name), corpus, copy.root, join(copy.root, "out", corpus.label, "owned"), throughDocsDoor);
        rmSync(join(copy.root, "templates"), { recursive: true, force: true });
        emitted += Object.keys(packaged).filter((path) => path !== REFUSED).length;
        expect(Object.keys(mine).sort(), `${entry.name} over ${corpus.label}`).toEqual(Object.keys(packaged).sort());
        for (const [path, content] of Object.entries(packaged)) {
          const [a, b] = copy.handsRuntimeOver ? [adapterNeutral(content), adapterNeutral(mine[path]!)] : [content, mine[path]!];
          expect(`${path}:\n${b}`, `${entry.name} over ${corpus.label}`).toBe(`${path}:\n${a}`);
        }
      }
      // An empty emit on both sides compares equal and proves nothing.
      expect(emitted, `${entry.name} emitted nothing over ${CORPORA.map((c) => c.label).join(", ")}`).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------------------
// the shared file itself, and the release gate
// ---------------------------------------------------------------------------------------

describe("eject contract — the shared file", () => {
  test("every exemption carries a reason and a ruling", () => {
    for (const [name, spec] of Object.entries(manifest.generators)) {
      if (spec.eject === "full") continue;
      expect(Object.keys(spec.eject).sort(), name).toEqual(["exempt", "ruling"]);
      expect(spec.eject.exempt.trim(), name).not.toBe("");
      expect(spec.eject.ruling.trim(), name).not.toBe("");
    }
  });

  test("every port declares an engine surface", () => {
    expect(Object.keys(manifest.eject.engineSurface).sort()).toEqual([...manifest.ports].sort());
  });

  test("the pending list is empty (the 1.1.0 release gate)", () => {
    // Skipped only by the shared file's named switch, which the release branch sets false.
    if (manifest.eject[RELEASE_SWITCH] === true) return;
    expect(manifest.eject.pending.filter((p) => p.port === PORT)).toEqual([]);
  });
});
