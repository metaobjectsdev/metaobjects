// FR-040 §4.2(a) — `meta eject <generator>` takes ownership of any reference-template
// generator, in any package, at any time after `meta init`. ADR-0034 scaffold-and-own
// has `init` copy four of them eagerly (entity, queries, routes, barrel); this is the
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

// Mirrors `OWNED_GENERATORS_DIR` in init.ts's `writeOwnedGenerators` — same directory,
// same never-clobber-without-consent contract. Kept as its own local constant rather
// than shared: eject is a standalone operation on ANY name, not a byproduct of init,
// and the two call sites have no other state in common worth coupling over one string.
const OWNED_GENERATORS_DIR = "codegen/generators";

/**
 * Bridges a CLI-supplied `string` to a package's own literal-union template-name type
 * with a real runtime check the compiler can narrow on — never an unchecked `as any` /
 * `as never` cast. `N` is inferred from the `names` array actually passed (each
 * package's own `REFERENCE_GENERATOR_NAMES` `as const` tuple), so the narrowing lines
 * up exactly with what that package's `readReferenceTemplate` expects.
 */
function assertKnownName<N extends string>(names: readonly N[], name: string): asserts name is N {
  if (!(names as readonly string[]).includes(name)) {
    throw new Error(`"${name}" is not one of: ${names.join(", ")}`);
  }
}

interface TemplateSource {
  packageName: string;
  names: readonly string[];
  read: (name: string) => string;
}

// One registry, three readers — a package that gains templates later registers itself
// here and `meta eject` picks it up with no other change.
const SOURCES: TemplateSource[] = [
  {
    packageName: "@metaobjectsdev/codegen-ts",
    names: coreTpl.REFERENCE_GENERATOR_NAMES,
    read: (name) => {
      assertKnownName(coreTpl.REFERENCE_GENERATOR_NAMES, name);
      return coreTpl.readReferenceTemplate(name);
    },
  },
  {
    packageName: "@metaobjectsdev/codegen-ts-react",
    names: reactTpl.REFERENCE_GENERATOR_NAMES,
    read: (name) => {
      assertKnownName(reactTpl.REFERENCE_GENERATOR_NAMES, name);
      return reactTpl.readReferenceTemplate(name);
    },
  },
  {
    packageName: "@metaobjectsdev/codegen-ts-tanstack",
    names: tanstackTpl.REFERENCE_GENERATOR_NAMES,
    read: (name) => {
      assertKnownName(tanstackTpl.REFERENCE_GENERATOR_NAMES, name);
      return tanstackTpl.readReferenceTemplate(name);
    },
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
  status: "created" | "preserved";
}

/** The `@metaobjectsdev/*` packages an ejected template imports, read from the file
 *  itself rather than from a per-name table — the template is the only thing that
 *  knows, and a table would drift from it the moment a template gains an import. */
function requiredPackages(templateSource: string): string[] {
  const found = new Set<string>();
  for (const m of templateSource.matchAll(/from\s+"(@metaobjectsdev\/[\w-]+)"/g)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * An ejected file is ordinary source in the adopter's repo, so its imports must be
 * declared dependencies or their `tsc` reports TS2307 on the file we just told them
 * they own — and under a strict (pnpm/npm) node_modules layout `meta gen` cannot
 * resolve it either. `meta init` already calls this out by ADDING the two packages its
 * four scaffolded generators need; the on-demand templates import two more
 * (codegen-ts-react, codegen-ts-tanstack) that nothing declares.
 *
 * This REPORTS rather than edits: init is a scaffolder writing a whole project and has
 * a manifest in hand, while eject copies one file into a repo whose dependency policy
 * (workspace protocol, catalog, pinned ranges) is the adopter's. Naming the exact
 * missing package and the version to match is the useful half; silently rewriting
 * someone's manifest is not.
 */
async function dependencyNotes(cwd: string, templateSource: string): Promise<string[]> {
  const required = requiredPackages(templateSource);
  if (required.length === 0) return [];

  let declared: Set<string>;
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
  } catch {
    // No readable manifest — say what the file needs and let the adopter place it.
    return [`This file imports: ${required.join(", ")}. Make sure each is installed.`];
  }

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

  const templateSource = source.read(opts.name);
  const importLine = extractImportLine(templateSource, opts.name);
  const exportName = extractExportName(importLine, opts.name);
  const rel = `${OWNED_GENERATORS_DIR}/${opts.name}.ts`;
  const abs = join(opts.cwd, rel);
  const notes = await dependencyNotes(opts.cwd, templateSource);
  const common = {
    path: rel,
    importLine,
    exportName,
    packageName: source.packageName,
    dependencyNotes: notes,
  };

  if (!opts.force && (await fileExists(abs))) {
    return { ...common, status: "preserved" };
  }

  await mkdir(join(opts.cwd, OWNED_GENERATORS_DIR), { recursive: true });
  await writeFile(abs, templateSource, "utf8");
  return { ...common, status: "created" };
}

function listOutput(): string {
  const lines: string[] = [];
  lines.push("Ejectable generators (copy any of these into codegen/generators/ and own it):");
  lines.push("");
  for (const source of SOURCES) {
    lines.push(`${source.packageName}:`);
    lines.push(`  ${source.names.join(", ")}`);
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
    log.info(listOutput());
    return 0;
  }

  if (flags.name === undefined) {
    log.error("meta eject requires a generator name, or --list to see what's ejectable.");
    return 2;
  }

  try {
    const result = await ejectGenerator({ cwd, name: flags.name, force: flags.force });
    if (result.status === "preserved") {
      log.info(`${result.path} already exists — left untouched (pass --force to overwrite).`);
    } else {
      log.info(`Ejected "${flags.name}" -> ${result.path}. You own it now (ADR-0034 scaffold-and-own).`);
    }
    // REPLACE, never "paste". A generator reaches `generators: [...]` under ONE binding,
    // and for every template but the four `meta init` scaffolds that binding already
    // exists as a package import (`import { formFile } from "@metaobjectsdev/codegen-ts-react"`
    // is what the docs show). Told to "paste", a reader gets a duplicate identifier at
    // best — and at worst deletes nothing, keeps `formFile()` in the array bound to the
    // PACKAGE import, and silently runs the packaged generator while editing the ejected
    // file. That failure is invisible and is the exact one ejecting exists to prevent.
    log.info(
      `In metaobjects.config.ts, REPLACE the existing import of "${result.exportName}" ` +
      `(it currently comes from "${result.packageName}") with:`,
    );
    log.info(`  ${result.importLine}`);
    log.info(
      `Leave the ${result.exportName}() entry in \`generators\` as it is — it now resolves ` +
      "to your local copy. If you add the import without removing the package one, the " +
      "config still runs the PACKAGED generator and your edits do nothing.",
    );
    for (const line of result.dependencyNotes) log.info(line);
    return 0;
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }
}
