// FR-040 §4.2(a) — `meta eject <generator>...` takes ownership of any reference-template
// generator, in any package, at any time after `meta init`.
//
// This is the copy door, for a generator an adopter wants to CHANGE: `meta init`
// scaffolds the layout and an empty selection, and a generator run as shipped is
// imported from its package without coming through here (ADR-0034 Amendment 5). It takes
// MANY names, because a real selection is several — choosing a client tier is
// `form hooks grid` — and three separate invocations produce three separate install
// lines for the same package. The consolidated install set is the point.
//
// It REPORTS; it never edits `metaobjects.config.ts` or `package.json`. ADR-0034 §3(c)
// already rules out a parameterized add/configure surface; the config is user-owned
// TypeScript with comments, and automated mutation of a real user config is the
// persistently fragile step even for well-resourced teams (Nuxt's `nuxi module add`
// config-array edit has regressed across at least four filed issues). The primary
// consumer performs two file edits and one install trivially when told exactly what
// they are. `meta gen` plus `tsc` is the audit.
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile, stat, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cliVersion } from "../lib/version.js";
import * as coreTpl from "@metaobjectsdev/codegen-ts";
import * as reactTpl from "@metaobjectsdev/codegen-ts-react";
import * as tanstackTpl from "@metaobjectsdev/codegen-ts-tanstack";
import { parseEjectArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { declaredDependencyNames, readPackageManifest } from "../lib/package-manifest.js";
import { compareOwnedCopy, type OwnedComparison } from "../lib/owned-copy.js";
import { composeCatalog, CORE_CODEGEN_PACKAGE, factoryModuleOf, packageOf } from "../lib/catalog.js";
import { dependencyRangesOf, installSetFor, type InstallSet, type OwnedRuntimeInstall } from "../lib/install-set.js";
import {
  ejectRuntime, ejectsRuntime, runtimeCopyStatus, runtimeDiffCommand, runtimeInstall,
  type RuntimeEjectResult, type RuntimeFileResult,
} from "../lib/runtime-eject.js";
import {
  closureOf, ejectTemplates, OWNED_TEMPLATES_DIR, packagedTemplates, predatesTemplateHandOver,
  templateCopyStatus, templateDiffCommand, type TemplateEjectResult, type TemplateFileResult,
} from "../lib/template-eject.js";
import { HTTP_RUNTIME_PACKAGE, OWNED_RUNTIME_DIR } from "@metaobjectsdev/codegen-ts";
import { emitStructured, type OutputFormat } from "../lib/format.js";
import {
  ejectLibrary, ejectableLibraryNames, isLibraryName, libraryStaleness,
  type LibraryEjectResult,
} from "../lib/library-eject.js";
import { describeError } from "../lib/error-text.js";
import { DOCS_SITE_NAME, ejectDocsSite, type DocsSiteFileResult } from "../lib/docs-site-eject.js";

// Mirrors `OWNED_GENERATORS_DIR` in init.ts's `writeOwnedGenerators` — same directory,
// same never-clobber-without-consent contract. Kept as its own local constant rather
// than shared: eject is a standalone operation on ANY name, not a byproduct of init,
// and the two call sites have no other state in common worth coupling over one string.
const OWNED_GENERATORS_DIR = "codegen/generators";

interface TemplateSource {
  packageName: string;
  names: readonly string[];
  /** That package's own `src/reference/` directory. */
  root: () => string;
}

// One registry, three packages — a package that gains templates later registers itself
// here and `meta eject` picks it up with no other change.
//
// Each entry exposes its reference ROOT rather than a read function. The packages' own
// `readReferenceTemplate` narrows its parameter to a literal union, so calling it with
// a CLI-supplied `string` used to need a generic `asserts name is N` helper — ~20 lines
// to re-establish, for the compiler, a fact `resolveSource` has ALREADY established at
// runtime by selecting this entry via `names.includes(name)`. Reading from the root
// deletes that machinery without weakening anything: membership is still checked, once,
// where the untrusted value enters.
const SOURCES: TemplateSource[] = [
  {
    packageName: CORE_CODEGEN_PACKAGE,
    names: coreTpl.REFERENCE_GENERATOR_NAMES,
    root: coreTpl.resolveReferenceRoot,
  },
  {
    packageName: "@metaobjectsdev/codegen-ts-react",
    names: reactTpl.REFERENCE_GENERATOR_NAMES,
    root: reactTpl.resolveReferenceRoot,
  },
  {
    packageName: "@metaobjectsdev/codegen-ts-tanstack",
    names: tanstackTpl.REFERENCE_GENERATOR_NAMES,
    root: tanstackTpl.resolveReferenceRoot,
  },
];

function resolveSource(name: string): TemplateSource | undefined {
  return SOURCES.find((s) => s.names.includes(name));
}


/** Line counts ignore order, so a pure reorder reads 0/0; say so (Python and C# do too). */
export function reorderedSuffix(behind: number, own: number): string {
  return behind === 0 && own === 0 ? ", reordered" : "";
}

/** Every ejectable name, in registry order (stable — matches `meta eject --list`). */
export function ejectableNames(): string[] {
  return SOURCES.flatMap((s) => s.names);
}

// Every reference template's header documents its own paste-ready import line, e.g.
// codegen-ts/src/reference/entity.ts:
//   // Then import it LOCALLY in metaobjects.config.ts:
//   //   import { entityFile } from "./codegen/generators/entity.js";
// Extracting it here — rather than re-deriving an export symbol from the file name —
// means eject can never drift from what the template itself already tells a human to
// paste, and needs no per-name export-symbol map: a generator's exported symbol does
// NOT follow its file name (`hooks.ts` exports `tanstackQuery`, `routes-hono.ts`
// exports `routesFileHono`, `grid.ts` exports `tanstackGrid`).
const HEADER_IMPORT_RE = /^\/\/\s+(import \{ \w+ \} from "\.\/codegen\/generators\/[\w.-]+\.js";)\s*$/m;

/** The bound symbol out of the already-validated import line — same single source of
 *  truth as the line itself, so the "replace this binding" message can never name a
 *  symbol the template does not actually export. */
function extractExportName(importLine: string, name: string): string {
  const match = /^import \{ (\w+) \}/.exec(importLine);
  if (!match?.[1]) {
    throw new Error(`reference template "${name}" has an unparseable import line: ${importLine}`);
  }
  return match[1];
}

// The CALL a template's header documents, when it is not the bare `<export>()`. A factory
// that cannot be called without options says so where it says how to import it
// (`//   generators: [sharedModelFile({ name, include })]`). Read from the header for the
// reason the import line is: the template is the one thing that knows, and the catalog
// deliberately does not derive a call from an options summary.
const HEADER_ENTRY_RE = /^\/\/\s+generators: \[(\w+\(.*\))\],?\s*$/m;

/** The call to wire: the header's, when it documents one for this template's own export. */
function extractEntry(templateSource: string, exportName: string): string {
  const call = HEADER_ENTRY_RE.exec(templateSource)?.[1];
  return call !== undefined && call.startsWith(`${exportName}(`) ? call : `${exportName}()`;
}

function extractImportLine(templateSource: string, name: string): string {
  const match = HEADER_IMPORT_RE.exec(templateSource);
  if (!match?.[1]) {
    throw new Error(
      `reference template "${name}" has no documented "// import { ... }" header line — ` +
        "cannot report the import line to paste.",
    );
  }
  return match[1];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export interface EjectOptions {
  cwd: string;
  name: string;
  /** Overwrite an already-ejected file. Without it, eject NEVER clobbers — matching
   *  `writeOwnedGenerators`'s unconditional preserve-if-present rule in init.ts. */
  force?: boolean;
}

export interface EjectResult {
  path: string;
  importLine: string;
  /** The symbol the template exports — the binding to REPLACE in the config. */
  exportName: string;
  /** The call to wire, with any options the factory cannot be called without
   *  (`sharedModelFile({ name, include })`), as the template's header documents it. */
  entry: string;
  /** The package the generator currently comes from, i.e. the import to remove. */
  packageName: string;
  /** Advisory lines about packages the ejected file imports but the project lacks. */
  dependencyNotes: string[];
  /** Every `@metaobjectsdev/*` package the ejected file imports (declared or not) — what
   *  the consolidated install summary folds in, so it covers each per-file line. */
  templatePackages: string[];
  status: "created" | "preserved" | "replaced";
  /**
   * How the file ALREADY on disk compares to the reference template this CLI ships.
   * `undefined` when there was no file.
   *
   * An owned copy is the one artifact ADR-0034 hands an adopter and then never speaks
   * about again. It can sit any number of releases behind the engine it runs against —
   * on the public reference app three of them were ~five minor lines stale, carrying a
   * bare `ts-poet` import (the 0.21.6 split-tree defect), the pre-#248 subtype
   * persistability check and a missing `isWriteThrough` branch — and every gate was
   * green, because nothing compares an owned copy to anything. Reporting this is the
   * cheapest thing that makes that condition observable.
   */
  comparison?: OwnedComparison | undefined;
  /**
   * ADR-0034 Amendment 3 (2026-09-24): the HTTP-adapter source this generator's OUTPUT
   * imports, copied into `codegen/runtime/` so the adopter owns that too. Absent for a
   * generator whose output imports no adapter.
   */
  runtime?: RuntimeEjectResult | undefined;
  /**
   * ADR-0034 Amendment 8: the template modules this generator calls to write its output,
   * copied into `codegen/templates/` so the adopter owns those too. Absent for a generator
   * that calls none (`barrel`).
   */
  templates?: TemplateEjectResult | undefined;
}

/** The `@metaobjectsdev/*` packages an ejected template imports, read from the file
 *  itself rather than from a per-name table — the template is the only thing that
 *  knows, and a table would drift from it the moment a template gains an import. */
function requiredPackages(templateSource: string): string[] {
  const found = new Set<string>();
  // The optional trailing group matches a SUBPATH and is deliberately not captured: what
  // has to be installed is the package, and `@metaobjectsdev/metadata/constants` is a
  // real, documented subpath this codebase already uses (the browser-safe pure-constants
  // entry). Requiring the closing quote straight after the package name — as this did —
  // made any such import match nothing at all, so a template gaining one would get no
  // note. That is the drift this function exists to prevent, reappearing inside the
  // function itself.
  for (const m of templateSource.matchAll(/from\s+"(@metaobjectsdev\/[\w-]+)(?:\/[\w./-]+)?"/g)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * An ejected file is ordinary source in the adopter's repo, so its imports must be
 * declared dependencies or their `tsc` reports TS2307 on the file we just told them
 * they own — and under a strict (pnpm/npm) node_modules layout `meta gen` cannot
 * resolve it either. `meta init` already calls this out by ADDING the two packages its
 * five scaffolded generators need; the on-demand templates import two more
 * (codegen-ts-react, codegen-ts-tanstack) that nothing declares.
 *
 * This REPORTS rather than edits: init is a scaffolder writing a whole project and has
 * a manifest in hand, while eject copies one file into a repo whose dependency policy
 * (workspace protocol, catalog, pinned ranges) is the adopter's. Naming the exact
 * missing package and the version to match is the useful half; silently rewriting
 * someone's manifest is not.
 */
export async function dependencyNotesForTemplate(
  cwd: string,
  templateSource: string,
  /** Packages the template modules copied beside the generator import, as well. */
  alsoImported: readonly string[] = [],
): Promise<string[]> {
  const required = [...new Set([...requiredPackages(templateSource), ...alsoImported.filter((p) => p.startsWith("@metaobjectsdev/"))])].sort();
  if (required.length === 0) return [];

  const pkg = readPackageManifest(cwd);
  if (pkg === undefined) {
    // No readable manifest — say what the file needs and let the adopter place it.
    return [`This file imports: ${required.join(", ")}. Make sure each is installed.`];
  }
  const declared = declaredDependencyNames(pkg);

  const missing = required.filter((p) => !declared.has(p));
  if (missing.length === 0) return [];
  return [
    `The ejected file imports ${missing.join(", ")}, which your package.json does not ` +
    "declare — your typecheck will report TS2307 until it does. Install with:",
    `  npm i -D ${missing.map((p) => `${p}@^${cliVersion()}`).join(" ")}`,
  ];
}

export async function ejectGenerator(opts: EjectOptions): Promise<EjectResult> {
  const source = resolveSource(opts.name);
  if (source === undefined) {
    throw new Error(
      `unknown generator "${opts.name}". Ejectable generators: ${ejectableNames().join(", ")}. ` +
        "Run `meta eject --list` to see them grouped by package.",
    );
  }

  // What is written is the reference with its module specifiers pointed at the project:
  // its template modules are copied beside it (ADR-0034 Amendment 8).
  const closure = closureOf(opts.name);
  const templateSource = closure.generator.content;
  const importLine = extractImportLine(templateSource, opts.name);
  const exportName = extractExportName(importLine, opts.name);
  const rel = `${OWNED_GENERATORS_DIR}/${opts.name}.ts`;
  const abs = join(opts.cwd, rel);
  const notes = await dependencyNotesForTemplate(opts.cwd, templateSource, closure.packages);
  const common = {
    path: rel,
    importLine,
    exportName,
    entry: extractEntry(templateSource, exportName),
    packageName: source.packageName,
    dependencyNotes: notes,
    templatePackages: closure.packages.filter((p) => p.startsWith("@metaobjectsdev/")),
  };

  const existing = (await fileExists(abs)) ? await readFile(abs, "utf8") : undefined;
  const comparison =
    existing === undefined ? undefined : await compareOwnedCopy(existing, templateSource);

  // The adapter source the OUTPUT imports is part of what is handed over — copied whether
  // or not the generator file itself was already here, and under the same never-clobber
  // rule, so re-running eject fills in a missing copy without touching a kept one.
  // Except when the KEPT copy predates that hand-over (1.0.9): with no `runtimeImport`
  // option its output imports the published package, so the copy would be dead code —
  // a Drizzle adapter, and its dependencies, in a project that may have no database.
  const keptCopyImportsPackage =
    existing !== undefined && !opts.force && !existing.includes("runtimeImport");
  const runtime = ejectsRuntime(opts.name) && !keptCopyImportsPackage
    ? await ejectRuntime(opts.cwd, [opts.name], opts.force === true)
    : undefined;

  // The template modules follow the same rule, for the same reason: a kept copy that predates
  // the hand-over still imports the emit code from the package, so copying the modules beside
  // it would be dead code in the project.
  const keptCopyPredatesTemplates =
    existing !== undefined && !opts.force && predatesTemplateHandOver(existing, closure);
  const templates = closure.templates.length > 0 && !keptCopyPredatesTemplates
    ? await ejectTemplates(opts.cwd, [closure], opts.force === true)
    : undefined;

  if (!opts.force && existing !== undefined) {
    return { ...common, status: "preserved", comparison, runtime, templates };
  }

  await mkdir(join(opts.cwd, OWNED_GENERATORS_DIR), { recursive: true });
  await writeFile(abs, templateSource, "utf8");
  return {
    ...common,
    status: existing === undefined ? "created" : "replaced",
    comparison,
    runtime,
    templates,
  };
}

/**
 * The owned HTTP-adapter copy under `codegen/runtime/`, file by file, against the installed
 * `@metaobjectsdev/runtime-ts` it was copied from. Shared by `meta eject --list` and
 * `meta gen --list`. Empty when the project owns no adapter copy.
 *
 * `identical` says an upgrade can be taken by re-copying (`meta eject <name> --force`);
 * `DIFFERS` says the copy is yours in a way the package is not — your fix, or upstream's —
 * and names the diff that tells which.
 */
export async function runtimeCopyLines(cwd: string): Promise<string[]> {
  const rows = await runtimeCopyStatus(cwd);
  if (rows.length === 0) return [];
  const lines: string[] = [
    `HTTP adapter source this project owns (${OWNED_RUNTIME_DIR}/), against the installed ${HTTP_RUNTIME_PACKAGE}:`,
  ];
  const differing: string[] = [];
  for (const r of rows) {
    if (r.verdict === "identical") lines.push(`  ${r.path}  [identical to the package]`);
    else if (r.verdict === "reformatted") lines.push(`  ${r.path}  [same content as the package, your formatting]`);
    else if (r.verdict === "not-in-package") lines.push(`  ${r.path}  [not in the package — yours, or removed upstream]`);
    else {
      differing.push(r.path);
      lines.push(
        `  ${r.path}  [DIFFERS: ${r.referenceOnly} line(s) only in the package, ${r.localOnly} line(s) only in yours${reorderedSuffix(r.referenceOnly, r.localOnly)}]`,
      );
    }
  }
  if (differing.length > 0) {
    lines.push("  See the difference (upstream fix, or your own?) before taking an upgrade:");
    for (const p of differing) lines.push(`    ${runtimeDiffCommand(p)}`);
  }
  lines.push("");
  return lines;
}

/**
 * The owned template modules under `codegen/templates/`, file by file, against what the
 * installed packages would write there today. Shared by `meta eject --list` and
 * `meta gen --list`. Empty when the project owns no template copy.
 *
 * Only the import lines of a copy differ from the package by design, so the comparison is
 * the one the generator copies get: `identical` says an upgrade can be taken by re-copying
 * (`meta eject <name> --force`); `DIFFERS` says the copy is yours in a way the package is
 * not, and names the diff that tells whose change it is.
 */
export async function templateCopyLines(cwd: string): Promise<string[]> {
  if (!existsSync(join(cwd, OWNED_TEMPLATES_DIR))) return [];
  const rows = await templateCopyStatus(cwd, packagedTemplates());
  if (rows.length === 0) return [];
  const lines: string[] = [
    `Template source this project owns (${OWNED_TEMPLATES_DIR}/), against the installed codegen packages:`,
  ];
  const differing: string[] = [];
  for (const r of rows) {
    if (r.verdict === "identical") lines.push(`  ${r.path}  [identical to the package]`);
    else if (r.verdict === "reformatted") lines.push(`  ${r.path}  [same content as the package, your formatting]`);
    else if (r.verdict === "not-in-package") lines.push(`  ${r.path}  [not in the package — yours, or removed upstream]`);
    else {
      const diff = templateDiffCommand(r);
      if (diff !== undefined) differing.push(diff);
      lines.push(
        `  ${r.path}  [DIFFERS: ${r.referenceOnly} line(s) only in the package, ${r.localOnly} line(s) only in yours${reorderedSuffix(r.referenceOnly, r.localOnly)}]`,
      );
    }
  }
  if (differing.length > 0) {
    lines.push(
      "  See the difference (upstream fix, or your own?) before taking an upgrade. " +
        "Only the import lines of a copy differ from the package by design:",
    );
    for (const d of differing) lines.push(`    ${d}`);
  }
  lines.push("");
  return lines;
}

/**
 * `--list` doubles as the staleness report for what this project ALREADY owns.
 *
 * A listing of names you could eject is the less useful half. The half nobody had is
 * "which of the copies I own have fallen behind" — the condition that let a reference
 * app run generators ~five minor lines old, carrying three retired patterns, with every
 * gate green. Marking each owned copy `identical` / `differs` makes it a one-command
 * answer instead of a diff nobody thinks to run.
 */
/** One reference generator as `--list` reports it: is a copy owned, and how far it moved. */
interface GeneratorListRow {
  name: string;
  package: string;
  /** `available` = not ejected; `owned` = ejected but the reference could not be read. */
  status: "available" | "owned" | "identical" | "reformatted" | "differs";
  /** Lines behind / of your own in the GENERATOR file alone. */
  behind: number;
  own: number;
  /**
   * The renderers this generator owns under `codegen/templates/` (those it imports that
   * exist in the project), each against the installed package. A generator is `identical`
   * only when its file AND every one of these is; `status` is `differs` when any differs.
   * Absent when the project owns none of its renderers.
   */
  templates?: GeneratorTemplateRow[];
  /**
   * The files under `codegen/runtime/` that differ from the installed adapter package, for a
   * generator whose output imports that adapter. Any makes `status` `differs`: the shipped
   * generator imports the package, so undoing this copy would drop the adapter edit unseen.
   * Absent when none differ.
   */
  runtime?: string[];
}

interface GeneratorTemplateRow {
  path: string;
  status: "identical" | "reformatted" | "differs";
  behind: number;
  own: number;
}

/** One `SOURCES` entry and the rows walked for it — the grouping the text list prints. */
interface GeneratorListGroup {
  packageName: string;
  rows: GeneratorListRow[];
}

async function generatorListGroups(cwd: string): Promise<GeneratorListGroup[]> {
  const groups: GeneratorListGroup[] = [];
  // Every renderer the project holds, against the package: attributed to a generator by what
  // that generator imports, so a renderer another generator owns never flags this one.
  const templateStatus = await templateCopyStatus(cwd, packagedTemplates());
  const changedRuntime = (await runtimeCopyStatus(cwd)).filter((r) => !isStockVerdict(r.verdict)).map((r) => r.path);
  for (const source of SOURCES) {
    const rows: GeneratorListRow[] = [];
    groups.push({ packageName: source.packageName, rows });
    for (const name of source.names) {
      const row: GeneratorListRow = { name, package: source.packageName, status: "available", behind: 0, own: 0 };
      rows.push(row);
      const abs = join(cwd, OWNED_GENERATORS_DIR, `${name}.ts`);
      if (!(await fileExists(abs))) continue;
      let ref: string;
      try {
        ref = closureOf(name).generator.content;
      } catch {
        row.status = "owned";
        continue;
      }
      const cmp = await compareOwnedCopy(await readFile(abs, "utf8"), ref);
      if (cmp.verdict === "identical" || cmp.verdict === "reformatted") {
        row.status = cmp.verdict;
      } else {
        row.status = "differs";
        row.behind = cmp.referenceOnly;
        row.own = cmp.localOnly;
      }
      const reached = new Set(closureOf(name).templates.map((f) => f.path));
      const renderers: GeneratorTemplateRow[] = [];
      for (const t of templateStatus) {
        if (!reached.has(t.path) || t.verdict === "not-in-package") continue;
        renderers.push({
          path: t.path,
          status: t.verdict === "identical" || t.verdict === "reformatted" ? t.verdict : "differs",
          behind: t.referenceOnly,
          own: t.localOnly,
        });
      }
      if (renderers.length > 0) row.templates = renderers;
      if (renderers.some((r) => r.status === "differs")) row.status = "differs";
      if (ejectsRuntime(name) && changedRuntime.length > 0) {
        row.runtime = changedRuntime;
        row.status = "differs";
      }
    }
  }
  return groups;
}

/** `--list` as one structured document: the generators and the shipped libraries. */
async function listData(cwd: string): Promise<Record<string, unknown>> {
  const generators = (await generatorListGroups(cwd)).flatMap((g) => g.rows);
  return {
    generators,
    libraries: ejectableLibraryNames(),
    help: [
      "run `meta eject <name>...` to copy a generator into codegen/generators/ and own it",
      "`meta eject --list --format text` also reports owned runtime copies and ejected-library drift",
    ],
  };
}

async function listOutput(cwd: string): Promise<string> {
  const lines: string[] = [];
  lines.push("Ejectable generators (copy any of these into codegen/generators/ and own it):");
  lines.push("");
  const groups = await generatorListGroups(cwd);
  const anyStale = groups.some((g) => g.rows.some((r) => r.status === "differs"));
  const generatorFileDiffers = (r: GeneratorListRow): boolean => r.behind > 0 || r.own > 0;
  for (const group of groups) {
    lines.push(`${group.packageName}:`);
    for (const r of group.rows) {
      if (r.status === "available") lines.push(`  ${r.name}`);
      else if (r.status === "owned") lines.push(`  ${r.name}  [owned]`);
      else if (r.status === "identical") lines.push(`  ${r.name}  [owned — identical to the reference]`);
      else if (r.status === "reformatted") lines.push(`  ${r.name}  [owned — same content as the reference, your formatting]`);
      else {
        const differing = (r.templates ?? []).filter((t) => t.status === "differs");
        const companions = [
          ...(differing.length > 0 ? [`${differing.length} renderer(s)`] : []),
          ...(r.runtime ? [`${r.runtime.length} runtime adapter file(s)`] : []),
        ];
        lines.push(
          generatorFileDiffers(r)
            ? `  ${r.name}  [owned — DIFFERS: ${r.behind} line(s) behind, ${r.own} line(s) of your own${reorderedSuffix(r.behind, r.own)}]`
            : `  ${r.name}  [owned — DIFFERS: generator identical, ${companions.join(" and ")} differ]`,
        );
        for (const t of differing) {
          lines.push(`    renderer ${t.path}  [DIFFERS: ${t.behind} line(s) behind, ${t.own} line(s) of your own${reorderedSuffix(t.behind, t.own)}]`);
        }
        for (const path of r.runtime ?? []) lines.push(`    runtime ${path}  [DIFFERS]`);
      }
    }
    lines.push("");
  }
  if (anyStale) {
    lines.push(
      "Both counts ignore formatting: each file is re-formatted and its lines sorted " +
        "before comparing, so re-wrapping and import order never show up here.",
    );
    lines.push(
      "  \"behind\"       — lines the reference has that your copy does not. Upstream moved.",
    );
    lines.push(
      "  \"of your own\"  — lines your copy has that the reference does not. Your customization.",
    );
    lines.push(
      "`meta eject <name>` prints the diff command that shows which lines they are.",
    );
    lines.push("");
  }
  lines.push(...(await runtimeCopyLines(cwd)));
  lines.push(...(await templateCopyLines(cwd)));
  // The docs site's theme: not a generator copy (its builder stays packaged), but a name
  // `meta eject` takes all the same.
  lines.push("The docs site's theme (its templates and assets, into codegen/docs-site/):");
  lines.push(`  ${DOCS_SITE_NAME}`);
  lines.push("");
  // FR-043 — the shipped libraries, and how far this project's copies have drifted.
  lines.push("Shipped libraries (copy one into your own sources and own it):");
  for (const name of ejectableLibraryNames()) lines.push(`  ${name}`);
  lines.push("");
  const staleness = await libraryStaleness(cwd);
  if (staleness.length > 0) {
    lines.push("Libraries this project has already ejected:");
    for (const row of staleness) {
      if (row.verdict === "unreadable") {
        lines.push(`  ${row.library}  [ejected — NOT COMPARED: ${row.reason}]`);
      } else if (row.verdict === "identical") {
        lines.push(`  ${row.library}  [ejected — identical to the shipped library]`);
      } else {
        lines.push(
          `  ${row.library}  [ejected — DIFFERS: ${row.changed} node(s) changed, ` +
            `${row.upstreamOnly} only upstream, ${row.localOnly} only yours]`,
        );
      }
      lines.push(`      ${row.files.join(", ")}`);
      if (row.stillOptedIn) {
        lines.push(
          `      STILL OPTED IN — remove "${row.library}" from \`libraries\`; the shipped ` +
            "tree and your copy both load, and deletions in yours do nothing.",
        );
      }
    }
    lines.push("");
    lines.push(
      "  Compared through the canonical serializer in OWN mode, so re-indentation and " +
        "key order never show up — only a declaration that actually changed. Nodes are " +
        "matched by NAME, so renaming the package (which you may) does not read as drift.",
    );
    lines.push(
      "  \"only upstream\" — the library gained or you deleted. \"only yours\" — you added.",
    );
    lines.push("");
  }

  lines.push("Run: meta eject <name>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// --undo: take back an owned copy that is the shipped reference
// ---------------------------------------------------------------------------

/** A copy comparison that found the shipped content, whatever the formatting. */
function isStockVerdict(verdict: string): boolean {
  return verdict === "identical" || verdict === "reformatted";
}

/** A generator row whose file, every renderer it reaches and its runtime adapter, are the shipped reference. */
function isStockRow(r: GeneratorListRow): boolean {
  return isStockVerdict(r.status);
}

/**
 * The advisory `meta gen` prints when owned generator copies are the shipped reference.
 *
 * An owned copy that never changed buys nothing: it freezes at the release it was copied
 * from and misses every later fix, while the same generator imports from its package. Most
 * were ejected while the stock generators could not be imported, and nothing noticed once
 * they could. Undefined when there are none, and free when the project owns no copy.
 */
export async function stockCopyNotice(cwd: string): Promise<string | undefined> {
  if (!existsSync(join(cwd, OWNED_GENERATORS_DIR))) return undefined;
  const stock = (await generatorListGroups(cwd)).flatMap((g) => g.rows).filter(isStockRow).map((r) => r.name);
  if (stock.length === 0) return undefined;
  const one = stock.length === 1;
  return (
    `${stock.length} owned generator cop${one ? "y is" : "ies are"} the shipped reference, unchanged ` +
    `(${stock.join(", ")}): ${one ? "it" : "they"} will miss the fixes later releases make. ` +
    `\`meta eject --undo\` removes ${one ? "it" : "them"} and prints the import to restore.`
  );
}

/** One owned copy `--undo` took back. */
interface UndoneRow {
  name: string;
  path: string;
  /** The edit in `metaobjects.config.ts` that runs the generator as shipped again. */
  wire: { import: string; replaces: string };
}

interface UndoKept {
  name: string;
  path: string;
  reason: string;
}

interface UndoPayload {
  undone: UndoneRow[];
  /** Every file removed: the generators, their copied renderers and adapter source. */
  removed: string[];
  kept: UndoKept[];
  /** Files under `codegen/` that were left because they differ from the package. */
  keptCompanions: string[];
}

function diffCommand(name: string, packageName: string, path: string): string {
  return `diff -u node_modules/${packageName}/src/reference/${name}.ts ${path}`;
}

async function pruneEmptyDirs(cwd: string, dirs: readonly string[]): Promise<void> {
  for (const d of dirs) {
    let dir = join(cwd, d);
    // Stop at `codegen/`'s children: `codegen/` itself may hold the adopter's own files.
    while (existsSync(dir) && readdirSync(dir).length === 0 && dir !== join(cwd, "codegen")) {
      await rmdir(dir);
      dir = dirname(dir);
    }
  }
}

/**
 * `meta eject --undo [<name>...]`. Removes owned generator copies that are the shipped
 * reference (file and every renderer it reaches), plus the renderer and adapter copies no
 * remaining owned generator uses. It never edits `metaobjects.config.ts`, as eject never
 * does: it names the import to swap back.
 *
 * Names are validated, and a customised copy refused, before anything is removed. With no
 * names a customised copy is simply kept and said so.
 */
async function undoCommand(names: readonly string[], force: boolean, cwd: string, fmt: OutputFormat): Promise<number> {
  const bad = names.filter((n) => resolveSource(n) === undefined);
  if (bad.length > 0) {
    log.error(
      `meta eject --undo takes generator names; not a generator: ${bad.join(", ")}. Nothing was removed. ` +
        "A library or the docs-site theme is your own data once ejected, so it is never undone. " +
        "Run `meta eject --list` to see what you own.",
    );
    return 2;
  }
  const owned = (await generatorListGroups(cwd)).flatMap((g) => g.rows).filter((r) => r.status !== "available");
  const named = names.length > 0;
  const targets = named ? owned.filter((r) => names.includes(r.name)) : owned.filter(isStockRow);
  const kept: UndoKept[] = [];
  const notOwned = names.filter((n) => !owned.some((r) => r.name === n));
  if (notOwned.length > 0) {
    log.error(
      `not an owned copy (nothing at ${OWNED_GENERATORS_DIR}/): ${notOwned.join(", ")}. Nothing was removed. ` +
        "Run `meta eject --list` to see what you own.",
    );
    return 2;
  }
  const refused = named && !force ? targets.filter((r) => !isStockRow(r)) : [];
  if (refused.length > 0) {
    for (const r of refused) {
      const path = `${OWNED_GENERATORS_DIR}/${r.name}.ts`;
      const changed = [
        ...(r.templates ?? []).filter((t) => t.status === "differs").map((t) => t.path),
        ...(r.runtime ?? []),
      ];
      log.error(
        `${path} differs from the ${r.package} reference (${r.behind} line(s) behind it, ${r.own} of your own` +
          `${changed.length > 0 ? `; changed with it: ${changed.join(", ")}` : ""}), ` +
          `so undoing it would discard your changes. See them: ${diffCommand(r.name, r.package, path)}`,
      );
    }
    log.error("Nothing was removed. Pass --force to remove a customised copy anyway.");
    return 2;
  }
  if (!named) {
    for (const r of owned.filter((o) => !isStockRow(o))) {
      kept.push({
        name: r.name,
        path: `${OWNED_GENERATORS_DIR}/${r.name}.ts`,
        reason: r.status === "owned" ? "owned, reference unreadable" : "customised — differs from the reference",
      });
    }
  }

  const gone = new Set(targets.map((r) => r.name));
  const remaining = owned.filter((r) => !gone.has(r.name));
  const stillReached = new Set(remaining.flatMap((r) => closureOf(r.name).templates.map((f) => f.path)));
  const removed: string[] = [];
  const keptCompanions: string[] = [];

  for (const r of targets) removed.push(`${OWNED_GENERATORS_DIR}/${r.name}.ts`);
  const templateRows = await templateCopyStatus(cwd, packagedTemplates());
  const dropTemplates = new Set(targets.flatMap((r) => (r.templates ?? []).map((t) => t.path)));
  for (const row of templateRows) {
    if (!dropTemplates.has(row.path) || stillReached.has(row.path)) continue;
    if (isStockVerdict(row.verdict)) removed.push(row.path);
    else keptCompanions.push(row.path);
  }
  // The adapter source is one shared tree: it goes only when nothing left in the project emits
  // code that imports it, and goes whole or not at all, so a forced undo never leaves half of it.
  const adapterDropped = targets.some((r) => ejectsRuntime(r.name)) && !remaining.some((r) => ejectsRuntime(r.name));
  if (adapterDropped) {
    const rows = await runtimeCopyStatus(cwd);
    const changed = rows.filter((row) => !isStockVerdict(row.verdict)).map((row) => row.path);
    if (changed.length === 0) removed.push(...rows.map((row) => row.path));
    else keptCompanions.push(...changed);
  }
  for (const rel of removed) await rm(join(cwd, rel), { force: true });
  await pruneEmptyDirs(cwd, [OWNED_TEMPLATES_DIR, OWNED_RUNTIME_DIR, OWNED_GENERATORS_DIR]);

  const undone: UndoneRow[] = targets.map((r) => {
    const closure = closureOf(r.name);
    const exportName = extractExportName(extractImportLine(closure.generator.content, r.name), r.name);
    return {
      name: r.name,
      path: `${OWNED_GENERATORS_DIR}/${r.name}.ts`,
      wire: {
        import: `import { ${exportName} } from "${factoryModuleOf(r.name) ?? r.package}";`,
        replaces: `import { ${exportName} } from "./${OWNED_GENERATORS_DIR}/${r.name}.js";`,
      },
    };
  });

  if (fmt !== "text") {
    const payload: UndoPayload = { undone, removed, kept, keptCompanions };
    emitStructured(payload, fmt);
    return 0;
  }
  if (undone.length === 0) {
    log.info(
      owned.length === 0
        ? "No owned generator copies: nothing to undo."
        : "Nothing to undo: every owned copy differs from the shipped reference.",
    );
  } else {
    log.info(`Removed ${removed.length} file(s); ${undone.length} generator(s) run as shipped again:`);
    for (const f of removed) log.info(`  ${f}`);
    log.info("In metaobjects.config.ts, REPLACE each import below (`meta gen` fails on the old one until you do):");
    for (const u of undone) log.info(`  ${u.wire.replaces}\n    -> ${u.wire.import}`);
    if (adapterDropped && keptCompanions.length === 0) {
      log.info(
        `The shipped routes generator imports its HTTP adapter from ${HTTP_RUNTIME_PACKAGE} rather than ` +
          `${OWNED_RUNTIME_DIR}/: install it, then re-run \`meta gen\`.`,
      );
    }
  }
  for (const k of kept) log.info(`Kept ${k.path}: ${k.reason}.`);
  if (keptCompanions.length > 0) {
    log.info(
      `Kept ${keptCompanions.length} file(s) under codegen/ that differ from the package: ` +
        `${keptCompanions.join(", ")}. \`meta eject --list\` compares each.`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

/**
 * The entry an ejected generator is wired by. Every generator, documentation included, goes
 * in the top-level `generators` and is run by `meta gen` (ADR-0034 Amendment 9).
 */
interface EjectWiring {
  /** The call, with the options the factory cannot be called without. */
  entry: string;
}

/** One row of the `--format json` payload. */
interface EjectedRow {
  name: string;
  path: string;
  status: EjectResult["status"];
  /** The two edits an adopter makes in `metaobjects.config.ts`: the import, and the entry in
   *  `generators`. */
  wire: { import: string; entry: string };
  requires: readonly string[];
  /** The adapter source copied beside it (ADR-0034 Amendment 3). Absent when none. */
  runtime?: RuntimeFileResult[];
  /** The template modules copied beside it (ADR-0034 Amendment 8). Absent when none. */
  templates?: TemplateFileResult[];
}

interface EjectPayload {
  ejected: EjectedRow[];
  install: InstallSet;
  /** Config keys the ejected generators read — what to set beside `generators`. */
  config: { keys: string[] };
  /** FR-043 — libraries ejected in this call. Absent when none were. */
  libraries?: LibraryEjectResult[];
  /** `meta eject docs-site`: the site's templates and assets. Absent when not asked for. */
  docsSite?: DocsSiteFileResult[];
}

/** The text report for `meta eject docs-site`. */
function reportDocsSite(files: readonly DocsSiteFileResult[]): void {
  const written = files.filter((f) => f.status !== "preserved").length;
  log.info(
    `Ejected the docs-site theme -> codegen/docs-site/: ${written} file(s) written, ` +
      `${files.length - written} already there and kept (--force replaces them).`,
  );
  log.info(
    "  docsSiteFile() reads these in place of the bundled templates and assets; edit them to own " +
      "the site's look. The site builder stays in the package. Wire the generator, if you have " +
      "not: `docsSiteFile()` in `generators`, with a `docs` target.",
  );
}

/** The text report for one ejected library. */
function reportLibrary(result: LibraryEjectResult): void {
  const created = result.files.filter((f) => f.status !== "preserved");
  const kept = result.files.filter((f) => f.status === "preserved");
  if (created.length > 0) {
    log.info(
      `Ejected library "${result.library}" -> ${result.root}:`,
    );
    for (const f of created) log.info(`  ${f.path}  [${f.status}]`);
  }
  if (kept.length > 0) {
    // Never clobber without consent — the same contract the generator path keeps, and
    // the stakes are higher here: these files are the adopter's MODEL.
    for (const f of kept) {
      log.info(`  ${f.path} already exists — left untouched (--force replaces it).`);
    }
  }
  log.info(
    `You own this metadata now (FR-043 §3.4): rename the package, delete what you do ` +
      `not need, change anything. Nothing regenerates it.`,
  );
  if (result.stillOptedIn.length > 0) {
    // The one step that makes the eject complete. Said here AND stamped in every file,
    // because the failure it prevents is silent in a way an adopter cannot diagnose.
    log.info(
      `NEXT: remove ${result.stillOptedIn.map((t) => `"${t}"`).join(", ")} from ` +
        `\`libraries\` in .metaobjects/config.json. Left there, the shipped tree and your ` +
        `copy BOTH load: additions take effect and deletions do NOT, because the library ` +
        `still declares what you removed. The loader refuses it outright ` +
        `(ERR_LIBRARY_PACKAGE_COLLISION) — your next command will fail until you do.`,
    );
  }
  log.info("`meta eject --list` reports how far your copy has drifted from the shipped one.");
}

/**
 * Validate EVERY name before writing ANY file.
 *
 * A partial eject is the worst outcome available here: a non-zero exit over a repo
 * that is half-changed, where re-running the fixed command then reports the
 * already-copied half as "preserved" and the adopter cannot tell what happened.
 * Returns the unknown names, or an empty array.
 */

function unknownNames(names: readonly string[]): string[] {
  return names.filter((n) => resolveSource(n) === undefined && !isLibraryName(n) && n !== DOCS_SITE_NAME);
}

/** Print the per-name text report — every branch below predates this command taking
 *  more than one name, and each was written against a real incident. */
function reportOne(result: EjectResult, name: string, wiring: EjectWiring): void {
  if (result.status === "preserved") {
    // "already exists — left untouched" was the whole message, and it answered the
    // question nobody has. What an owner needs to know is whether their copy still
    // matches what this CLI ships — the only way an owned generator's staleness is
    // ever observable, since no gate compares the two.
    if (result.comparison?.verdict === "identical") {
      log.info(
        `${result.path} already exists and is IDENTICAL to the ${result.packageName} ` +
          "reference template — nothing to do.",
      );
    } else if (result.comparison?.verdict === "reformatted") {
      // Worth its own branch: this is the state a project that formats what it owns
      // is in permanently, and calling it DIFFERS taught every one of them to ignore
      // the line that is supposed to warn them.
      log.info(
        `${result.path} already exists and has the SAME CONTENT as the ` +
          `${result.packageName} reference template, in your own formatting — ` +
          "nothing to do.",
      );
    } else {
      log.info(
        `${result.path} already exists and DIFFERS from the ${result.packageName} ` +
          `reference template (${result.comparison?.referenceOnly ?? 0} line(s) behind it, ` +
          `${result.comparison?.localOnly ?? 0} line(s) of your own) — left untouched.`,
      );
      log.info(
        "  Formatting is not counted: both files are re-formatted and their lines " +
          "sorted before comparing, so re-wrapping and import order never show up.",
      );
      log.info(
        "  That difference is either YOUR customization or upstream having moved on. " +
          "See which, before deciding:",
      );
      log.info(`    diff -u node_modules/${result.packageName}/src/reference/${name}.ts ${result.path}`);
      log.info("  (A copy differs from the reference in its import lines by design: they point at your project.)");
      log.info(
        "  To take upstream changes AND keep your customization, three-way merge them — " +
          "`git merge-file --diff3 <your copy> <the reference you ejected from> <the reference above>`. " +
          "`--force` does NOT merge: it replaces the file and your customization with it.",
      );
    }
  } else if (result.status === "replaced") {
    // Never let a --force over a modified file be silent: this is the step that
    // destroys an adopter's customization, and the file's own header is often the
    // only record that the customization was deliberate.
    log.info(
      `Ejected "${name}" -> ${result.path}, REPLACING the file that was there` +
        (result.comparison?.verdict === "differs"
          ? ` and DISCARDING ${result.comparison.localOnly} line(s) it had that the reference does not.`
          : result.comparison?.verdict === "reformatted"
            ? " (its content was already the reference's — only your formatting is gone)."
            : " (it was already identical to the reference)."),
    );
  } else {
    log.info(`Ejected "${name}" -> ${result.path}. You own it now (ADR-0034 scaffold-and-own).`);
  }

  {
    // REPLACE, never "paste". A generator reaches `generators: [...]` under ONE binding,
    // so a reader told to "paste" gets a duplicate identifier at best — and at worst
    // deletes nothing, keeps `formFile()` in the array bound to the PACKAGE import, and
    // silently runs the packaged generator while editing the ejected file. That failure
    // is invisible and is the exact one ejecting exists to prevent.
    //
    // But eject reads no config, so it cannot know WHICH of the three states this project
    // is in, and stating one of them as fact is wrong in the other two. Name the goal,
    // then the three branches; the reader knows which one they are looking at.
    log.info(`In metaobjects.config.ts, "${result.exportName}" must resolve to this file:`);
    log.info(`  ${result.importLine}`);
    log.info(
      `  - If it is imported from "${factoryModuleOf(name) ?? result.packageName}", REPLACE that import with the ` +
      "line above. Adding a second one leaves `generators` bound to the PACKAGED " +
      "generator, and your edits to this file do nothing.",
    );
    log.info(
      "  - If it is already imported from ./codegen/generators/, it points here already " +
      "— nothing to change.",
    );
    log.info(
      `  - If ${wiring.entry} is not in \`generators\` yet, add the import above ` +
      "AND the entry.",
    );
  }
  for (const line of result.dependencyNotes) log.info(line);
  if (result.runtime !== undefined && result.runtime.files.length > 0) reportRuntime(result.runtime.files);
  if (result.templates !== undefined && result.templates.files.length > 0) reportTemplates(result.templates.files);
}

/** What the template copy handed over, and how the owned generator reaches it. */
function reportTemplates(files: readonly TemplateFileResult[]): void {
  const written = files.filter((f) => f.status !== "preserved");
  // A kept file that already matches the package is not news (ejecting `entity queries` copies
  // the shared validators once, then finds them) — only a kept file that differs is.
  const kept = files.filter((f) => f.status === "preserved" && f.comparison?.verdict !== "identical");
  log.info(
    `The code this generator calls to write its output is yours too: its template modules are in ` +
      `${OWNED_TEMPLATES_DIR}/, not in the codegen package. What stays in the package is the engine ` +
      "(the generator base, the model walks, the naming and type-mapping tables).",
  );
  if (written.length > 0) {
    log.info(
      `  Copied ${written.length} file(s) into ${OWNED_TEMPLATES_DIR}/ (from the installed package; only their import lines differ).`,
    );
  }
  const keptDiffering = kept.filter((f) => f.comparison?.verdict === "differs");
  if (kept.length > 0) {
    log.info(
      `  ${kept.length} file(s) were already there and were left untouched` +
        (keptDiffering.length > 0 ? `, ${keptDiffering.length} of them differing from the package` : "") +
        " (--force replaces them). `meta eject --list` compares each one.",
    );
  }
}

/** What the adapter copy handed over, and how the emitted code reaches it. */
function reportRuntime(files: readonly RuntimeFileResult[]): void {
  const written = files.filter((f) => f.status !== "preserved");
  // A kept file that already matches the package is not news (ejecting `entity routes`
  // copies the shared allowlist file once, then finds it) — only a kept file that differs is.
  const kept = files.filter((f) => f.status === "preserved" && f.comparison?.verdict !== "identical");
  log.info(
    `The code this generator emits imports its HTTP adapter from ${OWNED_RUNTIME_DIR}/, not from ` +
      `${HTTP_RUNTIME_PACKAGE}: the adapter, filter parser, error envelopes and pagination are yours too.`,
  );
  if (written.length > 0) {
    log.info(`  Copied ${written.length} file(s) into ${OWNED_RUNTIME_DIR}/ (verbatim from the installed package).`);
  }
  const keptDiffering = kept.filter((f) => f.comparison?.verdict === "differs");
  if (kept.length > 0) {
    log.info(
      `  ${kept.length} file(s) were already there and were left untouched` +
        (keptDiffering.length > 0 ? `, ${keptDiffering.length} of them differing from the package` : "") +
        " (--force replaces them). `meta eject --list` compares each one.",
    );
  }
  log.info(
    `  To import the package instead, pass \`runtimeImport: "${HTTP_RUNTIME_PACKAGE}"\` to the generator.`,
  );
}

export async function ejectCommand(
  args: string[],
  cwd: string,
  fmt: OutputFormat = "text",
): Promise<number> {
  let flags;
  try {
    flags = parseEjectArgs(args);
  } catch (err) {
    log.error(describeError(err));
    return 2;
  }

  if (flags.undo) {
    if (flags.list) {
      log.error("meta eject: --undo does not combine with --list.");
      return 2;
    }
    return undoCommand(flags.names, flags.force, cwd, fmt);
  }

  if (flags.list) {
    if (fmt === "text") log.info(await listOutput(cwd));
    else emitStructured(await listData(cwd), fmt);
    return 0;
  }

  if (flags.names.length === 0) {
    log.error(
      "meta eject requires at least one generator name, or --list to see what's ejectable. " +
        "`meta gen --list --format json --probe` is the catalog, with a file count per " +
        "generator for your own model.",
    );
    return 2;
  }

  // All-or-nothing on the names, BEFORE any write — see unknownNames().
  const unmatched = unknownNames(flags.names);
  // A catalog entry with no reference template is PACKAGE-ONLY, not a typo — say so,
  // and say where it is imported from instead.
  const packageOnly = unmatched.filter((n) => packageOf(n) !== undefined);
  const unknown = unmatched.filter((n) => packageOf(n) === undefined);
  if (packageOnly.length > 0) {
    log.error(
      `package-only generator(s): ${packageOnly.map((n) => `${n} (${factoryModuleOf(n) ?? ""})`).join(", ")}. ` +
        "No reference template ships for them, so they cannot be ejected: import the factory " +
        "from the package named beside each one and wire it in `generators: [...]`. " +
        "Nothing was ejected.",
    );
  }
  if (unknown.length > 0) {
    log.error(
      `unknown name(s): ${unknown.join(", ")}. Nothing was ejected. ` +
        `Ejectable generators: ${ejectableNames().join(", ")}. ` +
        `Shipped libraries: ${ejectableLibraryNames().join(", ")}. ` +
        "Run `meta eject --list` to see them grouped.",
    );
  }
  if (unmatched.length > 0) return 2;

  const catalog = composeCatalog();
  const rows: EjectedRow[] = [];
  const libraries: LibraryEjectResult[] = [];
  const templatePackages = new Set<string>();
  // Packages OUTSIDE @metaobjectsdev that the copied template modules import (a Markdown/TOON
  // writer, say): read from the codegen package that ships them, never restated here.
  const templateThirdParty = new Map<string, string | undefined>();
  // ADR-0034 Amendment 3: the generators whose adapter source was copied, and what it imports.
  const runtimeGenerators = new Set<string>();
  const runtimePackages = new Set<string>();
  let docsSite: DocsSiteFileResult[] | undefined;
  try {
    for (const name of flags.names) {
      if (name === DOCS_SITE_NAME) {
        docsSite = await ejectDocsSite(cwd, flags.force);
        if (fmt === "text") reportDocsSite(docsSite);
        continue;
      }
      if (isLibraryName(name)) {
        const lib = await ejectLibrary({ cwd, name, force: flags.force });
        libraries.push(lib);
        if (fmt === "text") reportLibrary(lib);
        continue;
      }
      const result = await ejectGenerator({ cwd, name, force: flags.force });
      for (const p of result.templatePackages) templatePackages.add(p);
      for (const p of closureOf(name).packages.filter((q) => !q.startsWith("@metaobjectsdev/"))) {
        templateThirdParty.set(p, dependencyRangesOf(CORE_CODEGEN_PACKAGE)[p]);
      }
      if (result.runtime !== undefined) {
        runtimeGenerators.add(name);
        for (const p of result.runtime.packages) runtimePackages.add(p);
      }
      const catalogEntry = catalog[name];
      const wiring: EjectWiring = { entry: result.entry };
      rows.push({
        name,
        path: result.path,
        status: result.status,
        wire: { import: result.importLine, entry: wiring.entry },
        requires: catalogEntry?.requires ?? [],
        ...(result.runtime !== undefined ? { runtime: result.runtime.files } : {}),
        ...(result.templates !== undefined ? { templates: result.templates.files } : {}),
      });
      if (fmt === "text") reportOne(result, name, wiring);
    }
  } catch (err) {
    log.error(describeError(err));
    return 1;
  }

  // ONE install set for the whole call, not one per name: ejecting `hooks` and `grid`
  // needs @metaobjectsdev/codegen-ts-tanstack once, and an adopter handed the same
  // package twice reasonably wonders which line to run. It folds in what the ejected
  // FILES import as well as what the catalog says the generators need: the reference
  // templates import `@metaobjectsdev/metadata` at gen time, which no catalog entry
  // names, so a summary built from the catalog alone printed a line that omitted a
  // package each per-file note had just asked for.
  const entries = flags.names
    .filter((n) => !isLibraryName(n) && n !== DOCS_SITE_NAME)
    .map((n) => catalog[n])
    .filter((e) => e !== undefined);
  // The copied adapter source imports its own dependencies (qs, the framework, the core
  // `@metaobjectsdev/metadata`), and the generated code no longer imports the runtime
  // package — so the install line trades one for the other.
  let ownedRuntime: OwnedRuntimeInstall | undefined;
  if (runtimeGenerators.size > 0) {
    const { runtime, dev } = runtimeInstall([...runtimePackages]);
    ownedRuntime = { generators: runtimeGenerators, runtime, dev };
  }
  const install = installSetFor(entries, [...templatePackages], ownedRuntime, templateThirdParty);
  const configKeys = [...new Set(entries.flatMap((e) => e.configKeys ?? []))].sort();

  if (fmt === "text") {
    if (install.command !== "") {
      log.info("");
      log.info("Install what the ejected generators and their output need:");
      log.info(`  ${install.command}`);
    }
    if (configKeys.length > 0) {
      log.info(
        `These generators read config: ${configKeys.join(", ")} — set them in ` +
          "metaobjects.config.ts beside `generators`.",
      );
    }
    // Every requires edge the selection does not itself satisfy. `meta gen` warns
    // about this too, but saying it HERE is what stops the adopter wiring a broken
    // pair in the first place.
    const chosen = new Set(flags.names);
    const missing = [...new Set(rows.flatMap((r) => r.requires).filter((d) => !chosen.has(d)))].sort();
    if (missing.length > 0) {
      log.info(
        `Also needed: ${missing.join(", ")} — the code you just ejected imports modules ` +
          `${missing.length === 1 ? "that generator emits" : "those generators emit"}. ` +
          `Eject ${missing.length === 1 ? "it" : "them"} too, or keep your own.`,
      );
    }
  } else {
    const payload: EjectPayload = {
      ejected: rows,
      install,
      config: { keys: configKeys },
      ...(libraries.length > 0 ? { libraries } : {}),
      ...(docsSite !== undefined ? { docsSite } : {}),
    };
    emitStructured(payload, fmt);
  }

  return 0;
}
