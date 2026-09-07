// FR-040 §4.2(a) — `meta eject <generator>` takes ownership of any reference-template
// generator, in any package, at any time after `meta init`. ADR-0034 scaffold-and-own
// has `init` copy five of them eagerly (entity, queries, routes, barrel, names); this is the
// SAME copy operation, generalised to every ejectable name and callable on demand — for
// a generator you skipped at init time, or one a package gained since.
import { mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cliVersion } from "../lib/version.js";
import * as coreTpl from "@metaobjectsdev/codegen-ts";
import * as reactTpl from "@metaobjectsdev/codegen-ts-react";
import * as tanstackTpl from "@metaobjectsdev/codegen-ts-tanstack";
import { parseEjectArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { declaredDependencyNames, readPackageManifest } from "../lib/package-manifest.js";
import { compareOwnedCopy, type OwnedComparison } from "../lib/owned-copy.js";

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
    packageName: "@metaobjectsdev/codegen-ts",
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
  /** The package the generator currently comes from, i.e. the import to remove. */
  packageName: string;
  /** Advisory lines about packages the ejected file imports but the project lacks. */
  dependencyNotes: string[];
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
export async function dependencyNotesForTemplate(cwd: string, templateSource: string): Promise<string[]> {
  const required = requiredPackages(templateSource);
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

  const templateSource = await readFile(join(source.root(), `${opts.name}.ts`), "utf8");
  const importLine = extractImportLine(templateSource, opts.name);
  const exportName = extractExportName(importLine, opts.name);
  const rel = `${OWNED_GENERATORS_DIR}/${opts.name}.ts`;
  const abs = join(opts.cwd, rel);
  const notes = await dependencyNotesForTemplate(opts.cwd, templateSource);
  const common = {
    path: rel,
    importLine,
    exportName,
    packageName: source.packageName,
    dependencyNotes: notes,
  };

  const existing = (await fileExists(abs)) ? await readFile(abs, "utf8") : undefined;
  const comparison =
    existing === undefined ? undefined : await compareOwnedCopy(existing, templateSource);

  if (!opts.force && existing !== undefined) {
    return { ...common, status: "preserved", comparison };
  }

  await mkdir(join(opts.cwd, OWNED_GENERATORS_DIR), { recursive: true });
  await writeFile(abs, templateSource, "utf8");
  return {
    ...common,
    status: existing === undefined ? "created" : "replaced",
    comparison,
  };
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
async function listOutput(cwd: string): Promise<string> {
  const lines: string[] = [];
  lines.push("Ejectable generators (copy any of these into codegen/generators/ and own it):");
  lines.push("");
  let anyStale = false;
  for (const source of SOURCES) {
    lines.push(`${source.packageName}:`);
    for (const name of source.names) {
      const abs = join(cwd, OWNED_GENERATORS_DIR, `${name}.ts`);
      if (!(await fileExists(abs))) {
        lines.push(`  ${name}`);
        continue;
      }
      let ref: string;
      try {
        ref = await readFile(join(source.root(), `${name}.ts`), "utf8");
      } catch {
        lines.push(`  ${name}  [owned]`);
        continue;
      }
      const owned = await readFile(abs, "utf8");
      const cmp = await compareOwnedCopy(owned, ref);
      if (cmp.verdict === "identical") {
        lines.push(`  ${name}  [owned — identical to the reference]`);
      } else if (cmp.verdict === "reformatted") {
        lines.push(`  ${name}  [owned — same content as the reference, your formatting]`);
      } else {
        anyStale = true;
        lines.push(
          `  ${name}  [owned — DIFFERS: ${cmp.referenceOnly} line(s) behind, ` +
            `${cmp.localOnly} line(s) of your own]`,
        );
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
  lines.push("Run: meta eject <name>");
  return lines.join("\n");
}

export async function ejectCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parseEjectArgs(args);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  if (flags.list) {
    log.info(await listOutput(cwd));
    return 0;
  }

  if (flags.name === undefined) {
    log.error("meta eject requires a generator name, or --list to see what's ejectable.");
    return 2;
  }

  try {
    const result = await ejectGenerator({ cwd, name: flags.name, force: flags.force });
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
        log.info(`    diff -u node_modules/${result.packageName}/src/reference/${flags.name}.ts ${result.path}`);
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
        `Ejected "${flags.name}" -> ${result.path}, REPLACING the file that was there` +
          (result.comparison?.verdict === "differs"
            ? ` and DISCARDING ${result.comparison.localOnly} line(s) it had that the reference does not.`
            : result.comparison?.verdict === "reformatted"
              ? " (its content was already the reference's — only your formatting is gone)."
              : " (it was already identical to the reference)."),
      );
    } else {
      log.info(`Ejected "${flags.name}" -> ${result.path}. You own it now (ADR-0034 scaffold-and-own).`);
    }
    // REPLACE, never "paste". A generator reaches `generators: [...]` under ONE binding,
    // so a reader told to "paste" gets a duplicate identifier at best — and at worst
    // deletes nothing, keeps `formFile()` in the array bound to the PACKAGE import, and
    // silently runs the packaged generator while editing the ejected file. That failure
    // is invisible and is the exact one ejecting exists to prevent.
    //
    // But eject reads no config, so it cannot know WHICH of the three states this project
    // is in, and stating one of them as fact is wrong in the other two — including for the
    // five `meta init` scaffolds, whose config already imports from ./codegen/generators/,
    // which is precisely the `meta eject <name> --force` re-sync case. Name the goal, then
    // the three branches; the reader knows which one they are looking at.
    log.info(`In metaobjects.config.ts, "${result.exportName}" must resolve to this file:`);
    log.info(`  ${result.importLine}`);
    log.info(
      `  - If it is imported from "${result.packageName}", REPLACE that import with the ` +
      "line above. Adding a second one leaves `generators` bound to the PACKAGED " +
      "generator, and your edits to this file do nothing.",
    );
    log.info(
      "  - If it is already imported from ./codegen/generators/ (what `meta init` " +
      "scaffolds), it points here already — nothing to change.",
    );
    log.info(
      `  - If ${result.exportName}() is not in \`generators\` yet, add the import above ` +
      "AND the entry.",
    );
    for (const line of result.dependencyNotes) log.info(line);
    return 0;
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }
}
