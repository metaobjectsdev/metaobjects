import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createJiti } from "jiti";
import type { MetaDataTypeProvider, MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";
import { resolveCollection, type Collection } from "@metaobjectsdev/sdk";

const CONFIG_FILE = "metaobjects.config.ts";

// Prefix for the transient, pre-processed config the loader writes next to the
// user's config (see the rewrite step below). Normally deleted in a finally
// block; the prefix is also used to sweep any copies stranded by an abnormal
// exit so a consumer's `git status` never surfaces one.
const PROC_TEMP_PREFIX = ".metaobjects-config-proc-";

// Resolve @metaobjectsdev/codegen-ts from the CLI's own node_modules so that
// metaobjects.config.ts (which lives in the user's project) can import it even
// when the user's project has no direct dependency on the package.
//
// When compiled: import.meta.url is dist/src/lib/load-metaobjects-config.js — four
// levels up (past lib/, src/, dist/) reaches the CLI package root (packages/cli/).
// When run as TS source (e.g. bun test): import.meta.url is src/lib/load-metaobjects-config.ts
// — three levels up (past lib/, src/) reaches the package root.
const _thisFile = fileURLToPath(import.meta.url);
const _isCompiled = _thisFile.includes("/dist/");
const _cliDir = resolve(_thisFile, _isCompiled ? "../../../.." : "../../..");
const _require = createRequire(import.meta.url);
// Fallback layout for each codegen specifier (relative to _cliDir), used only
// when standard module resolution can't locate it. Compiled output lives in
// dist/; un-compiled runs (bun test, `meta` from the workspace) use src/ so the
// CLI never depends on a stale, unrebuilt dist/.
//
// @metaobjectsdev/cli is this package itself, so it resolves directly from
// _cliDir rather than through node_modules (which would be a non-existent
// self-referential symlink).
const CODEGEN_TS_PKG = "@metaobjectsdev/codegen-ts";
const TS_POET_PKG = "ts-poet";
const CLI_PKG_PATHS: Record<string, { dist: string; src: string }> = {
  [CODEGEN_TS_PKG]: {
    dist: "node_modules/@metaobjectsdev/codegen-ts/dist/index.js",
    src: "node_modules/@metaobjectsdev/codegen-ts/src/index.ts",
  },
  // Consumer configs that ship custom MetaDataTypeProviders import the type
  // primitives (TypeId, MetaField, TYPE_* …) from here. Aliased to the CLI's
  // own copy so the user's project needn't declare it as a direct dependency.
  "@metaobjectsdev/metadata": {
    dist: "node_modules/@metaobjectsdev/metadata/dist/index.js",
    src: "node_modules/@metaobjectsdev/metadata/src/index.ts",
  },
  "@metaobjectsdev/codegen-ts/generators": {
    dist: "node_modules/@metaobjectsdev/codegen-ts/dist/generators/index.js",
    src: "node_modules/@metaobjectsdev/codegen-ts/src/generators/index.ts",
  },
  "@metaobjectsdev/codegen-ts-react": {
    dist: "node_modules/@metaobjectsdev/codegen-ts-react/dist/index.js",
    src: "node_modules/@metaobjectsdev/codegen-ts-react/src/index.ts",
  },
  "@metaobjectsdev/codegen-ts-tanstack": {
    dist: "node_modules/@metaobjectsdev/codegen-ts-tanstack/dist/index.js",
    src: "node_modules/@metaobjectsdev/codegen-ts-tanstack/src/index.ts",
  },
  "@metaobjectsdev/cli": {
    dist: "dist/src/index.js",
    src: "src/index.ts",
  },
};

// Resolve a codegen specifier to an absolute path, so a user's
// metaobjects.config.ts can import @metaobjectsdev/codegen-ts* without
// declaring it directly — the CLI's own copy is used.
//
// Standard module resolution is tried first: it follows whatever node_modules
// layout exists — npm (flat), pnpm (deps as siblings in the virtual store,
// NOT nested under the CLI dir), or bun — and honors the package's export
// conditions. The CLI_PKG_PATHS fallback only kicks in when a specifier isn't
// require-resolvable from the CLI module.
//
// Under Bun's native loader `require.resolve` returns the TypeScript source
// path (via the "bun" export condition, e.g. `src/index.ts`). When a `.ts`
// path is returned, we prefer the compiled dist path (always a plain JS file)
// so the pre-processed config source references a deterministic artifact that
// won't be intercepted by stale ancestor node_modules directories.
function resolveCliPkg(specifier: string): string {
  const paths = CLI_PKG_PATHS[specifier];
  // The cli self-reference always points at this package's own entry, never a
  // (possibly absent) self-referential node_modules symlink.
  if (specifier === "@metaobjectsdev/cli" && paths !== undefined) {
    return resolve(_cliDir, _isCompiled ? paths.dist : paths.src);
  }
  try {
    const resolved = _require.resolve(specifier);
    // When Bun's native "bun" export condition returns a `.ts` source path,
    // prefer the compiled dist path so the pre-processed config references a
    // stable JS artifact that the loader can load without the "bun" condition
    // redirecting it to a different module instance.
    if (resolved.endsWith(".ts") && paths !== undefined) {
      const distCandidate = resolve(_cliDir, paths.dist);
      if (existsSync(distCandidate)) return distCandidate;
    }
    return resolved;
  } catch {
    if (paths !== undefined) {
      const candidate = resolve(_cliDir, _isCompiled ? paths.dist : paths.src);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(
      `metaobjects: could not resolve ${specifier} from the CLI — try reinstalling @metaobjectsdev/cli.`,
    );
  }
}

/**
 * Rewrite `from "specifier"` / `export … from "specifier"` / bare
 * `import "specifier"` occurrences for a known set of package specifiers.
 * Returns the original string unchanged when no substitutions are needed.
 *
 * This is necessary because jiti 2.x under Bun's native ESM loader does not
 * apply its `alias` map — Bun intercepts the `import()` call and resolves
 * modules itself, ignoring jiti's alias configuration. By rewriting the
 * specifiers in the source text before loading, we guarantee that absolute
 * paths are used regardless of which loader takes over.
 *
 * Relative imports (`./foo`, `../bar`) are intentionally NOT rewritten; they
 * must continue to resolve relative to the config file's own directory.
 *
 * Dynamic `import("specifier")` calls are NOT rewritten either — configs are
 * loaded eagerly and none of the scaffolded templates use them; a dynamic
 * import of an aliased package falls back to normal module resolution (and to
 * jiti's alias map on non-Bun runtimes).
 */
/**
 * 1.0 removed `entityFile` / `queriesFile` / `routesFile` / `barrel` from
 * `@metaobjectsdev/codegen-ts/generators` (ADR-0035 A3; ADR-0034 scaffold-and-own). Without
 * this check the removal surfaces as a bare runtime TypeError from the transpiled config —
 * `(0, _index2.entityFile) is not a function` — which names neither MetaObjects, nor the
 * removal, nor the one-command remedy. A breaking change an adopter WILL hit deserves a
 * diagnostic, and this is the only place that can give one: the subpath still exists (it is
 * the supported home of the generators with no ownable copy), so nothing upstream of here
 * can tell a correct import from a removed one.
 *
 * It reads the config SOURCE rather than catching the throw because the throw happens inside
 * a generator factory call with no reference back to the import that produced it, and only a
 * config declaring one of these in `generators: [...]` throws at all — a stale type-only
 * import would fail silently at typecheck-time instead.
 */
const REMOVED_GENERATOR_EXPORTS = ["entityFile", "queriesFile", "routesFile", "barrel"] as const;
const GENERATORS_SUBPATH = "@metaobjectsdev/codegen-ts/generators";

export function removedGeneratorImportError(source: string): string | undefined {
  const re = new RegExp(
    `import\\s*(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${GENERATORS_SUBPATH.replace(/[/\\]/g, "\\$&")}['"]`,
    "g",
  );
  const hits = new Set<string>();
  for (const m of source.matchAll(re)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
      if (name && (REMOVED_GENERATOR_EXPORTS as readonly string[]).includes(name)) hits.add(name);
    }
  }
  if (hits.size === 0) return undefined;
  const names = [...hits].sort();
  const templateOf = (n: string) => n.replace(/File$/, "");
  // One command per name: `meta eject` takes at most one generator name.
  const commands = names.map((n) => `    meta eject ${templateOf(n)}`).join("\n");
  const example = names[0] ?? "";
  return (
    `metaobjects.config.ts imports ${names.join(", ")} from "${GENERATORS_SUBPATH}". ` +
    `1.0 REMOVED ${names.length === 1 ? "that export" : "those exports"} (ADR-0034 scaffold-and-own): ` +
    `these generators are yours to own, so the package no longer ships them as an import.\n` +
    `  Fix — copy ${names.length === 1 ? "it" : "each of them"} into your repo:\n${commands}\n` +
    `  then import the copies, e.g. ` +
    `import { ${example} } from "./codegen/generators/${templateOf(example)}";\n` +
    `  The subpath itself is fine — promptRender, outputParser, routesFileHono and the rest ` +
    `still live there. Only ${names.length === 1 ? "this one" : `these ${names.length}`} moved.\n` +
    `  Guide: docs/features/migrations/0.x-to-1.0.md §11`
  );
}

function rewriteImportSpecifiers(source: string, aliasMap: Record<string, string>): string {
  let result = source;
  for (const [specifier, resolvedPath] of Object.entries(aliasMap)) {
    const esc = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Rewrite: from "specifier" or from 'specifier'
    // Covers: import { X } from "pkg", export { X } from "pkg"
    result = result.replace(
      new RegExp(`(\\bfrom\\s+)(['"])${esc}\\2`, "g"),
      (_m, prefix, quote) => `${prefix}${quote}${resolvedPath}${quote}`,
    );
    // Rewrite: import "specifier" or import 'specifier' (side-effect imports)
    result = result.replace(
      new RegExp(`(\\bimport\\s+)(['"])${esc}\\2`, "g"),
      (_m, prefix, quote) => `${prefix}${quote}${resolvedPath}${quote}`,
    );
  }
  return result;
}

/**
 * The `loadMemory` options a project's gen config contributes.
 *
 * One helper rather than a spread pair repeated at each of the eight load sites,
 * because threading one of these and forgetting the other is exactly how #333
 * happened: `providers` reached every command while `libraries` reached none, so a
 * generator was registered FOR the CLI with its input unreachable THROUGH it. Adding a
 * third contribution later should not mean finding eight call sites again.
 *
 * Conditional spreads honour `exactOptionalPropertyTypes` — a key is omitted rather
 * than set to `undefined`, which is what lets `loadMemory` apply its own defaults.
 */
export function loadMemoryOptionsFrom(
  cfg: Pick<MetaobjectsGenConfig, "providers" | "libraries"> | undefined,
): { providers?: readonly MetaDataTypeProvider[]; libraries?: readonly string[] } {
  return {
    ...(cfg?.providers !== undefined ? { providers: cfg.providers } : {}),
    ...(cfg?.libraries !== undefined ? { libraries: cfg.libraries } : {}),
  };
}

/**
 * The directory whose `metaobjects.config.ts` governs a run started in `startDir` —
 * the nearest ancestor carrying that file, `fallback` when there is none.
 *
 * This is a SECOND walk, deliberately separate from `resolveCollection`'s. The two
 * files answer different questions and design §4.6 already says so: `.metaobjects/
 * config.json` declares where metadata comes from — port-neutral, read by all five
 * CLIs, and reasonably repo-global in a polyglot monorepo — while
 * `metaobjects.config.ts` declares how THIS TypeScript package generates code. Reading
 * the second from the directory that carried the first (#326) meant a Maven- or
 * pip-rooted repo with a JS app underneath could not run `meta gen` at all: the
 * collection resolved to the repo root, and the app's config, sitting in the very
 * directory the command was invoked from, was never looked at.
 *
 * Nearest wins, which is what keeps the opposite arm — the divergence commit
 * 0c8fd136e fixed — closed: a run from a subdirectory that declares NO config of its
 * own walks up to the project root's, exactly as before, rather than silently
 * defaulting `columnNamingStrategy` and emitting a migration that renames every
 * column. When the two files sit together, as they do in every `meta init` project,
 * this walk and the collection walk return the same directory by construction.
 *
 * The `fallback` is the collection's directory, so a project with no
 * `metaobjects.config.ts` anywhere keeps today's diagnostics unchanged: this walk can
 * only ever move the answer CLOSER to the invocation, never further away.
 *
 * Boundaries mirror `discoverCollectionRoot` (sdk `discovery.ts`): the marker is
 * checked before `.git`, so a repo-root project sharing its directory with `.git` is
 * still reachable from any subdirectory, and the walk stops there so a monorepo can
 * never adopt a parent checkout's codegen config.
 */
export function resolveGenConfigDir(startDir: string, fallback: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

/**
 * The collection a TypeScript package GENERATES FROM (#340).
 *
 * #326/#327 established that the two config files answer different questions, and gave
 * `metaobjects.config.ts` its own walk. This is the remaining half of the same split:
 * a sub-project whose TS config sits below the collection root was still LOADING the
 * ancestor's whole source set, so its `src/generated` absorbed metadata belonging to
 * unrelated parts of the repository — one adopter's web app went from 376 files to 831,
 * the surplus being another module's server-side prompt payload DTOs. It fails OPEN
 * (`tsc` passes, tests pass), so the only symptom is a directory that quietly doubled.
 *
 * The rule: an ancestor `.metaobjects/config.json` is the DEFAULT for a package that
 * declares no sources of its own, never an ADDITION to one that does. So when the TS
 * config sits somewhere the collection did not, that directory is re-resolved as a
 * collection in its own right, and it wins if it actually resolves any metadata.
 *
 * It can only ever NARROW, and only in a shape that could not have worked before:
 *   - the two directories coincide (every `meta init` project, and every run from a
 *     project root) — returns the original, untouched, without a second resolve;
 *   - the sub-project declares no sources — the pinned resolve throws
 *     `ERR_SOURCE_UNRESOLVED` or comes back empty, and the ancestor stands, so a
 *     package that genuinely lives off an ancestor tree keeps working;
 *   - the sub-project has its own metadata — it generates from exactly that, which is
 *     what it did before source resolution learned to walk upward.
 *
 * Deliberately NOT applied to `.metaobjects/` STATE. Migrations, snapshots and the
 * operational block stay keyed on the discovered collection's directory (#326 settled
 * that); this narrows what is LOADED, and nothing about where state lives.
 */
export async function resolveGenCollection(
  collection: Collection,
  genConfigDir: string,
): Promise<Collection> {
  if (resolve(genConfigDir) === resolve(collection.configDir)) return collection;
  try {
    const pinned = await resolveCollection(genConfigDir, { explicitDir: genConfigDir });
    return pinned.files.length > 0 ? pinned : collection;
  } catch {
    // The sub-project declares nothing resolvable of its own — inherit, exactly as a
    // package with no config always has.
    return collection;
  }
}

export async function loadMetaobjectsConfig(projectRoot: string): Promise<MetaobjectsGenConfig> {
  const fullPath = resolve(projectRoot, CONFIG_FILE);
  if (!existsSync(fullPath)) {
    throw new Error(
      `metaobjects.config.ts not found at ${fullPath}. Run 'meta init' to scaffold one.`,
    );
  }

  // Self-heal: a SIGKILL mid-load can strand a pre-processed temp config
  // (PROC_TEMP_PREFIX*.ts) next to the user's config, since deletion normally
  // happens in the finally block below. Sweep any stale ones before loading so
  // an abnormal exit never pollutes the consumer's working tree.
  const configDir = dirname(fullPath);
  for (const entry of readdirSync(configDir)) {
    if (entry.startsWith(PROC_TEMP_PREFIX) && entry.endsWith(".ts")) {
      try { unlinkSync(resolve(configDir, entry)); } catch { /* best-effort */ }
    }
  }

  // Build the canonical alias map: specifier → resolved absolute path.
  const aliasMap: Record<string, string> = {};
  for (const specifier of Object.keys(CLI_PKG_PATHS)) {
    aliasMap[specifier] = resolveCliPkg(specifier);
  }

  // ts-poet must resolve to the SAME physical copy @metaobjectsdev/codegen-ts uses.
  // The scaffolded (ADR-0034 owned) generators compose ts-poet Code objects with the
  // engine's render* primitives, and ts-poet recognizes nested Code/Import
  // placeholders by `instanceof` — when the CLI tree and the project tree hold two
  // physical ts-poet copies (globally-installed or linked CLI + the project-local
  // devDependency `meta init` adds), a bare project-side `import ... from "ts-poet"`
  // splits the class identity and every cross-boundary section renders standalone
  // with its own import header (duplicate `import { eq } from "drizzle-orm"` —
  // TS2300 on the adopter's first tsc). Newly scaffolded templates import the
  // combinators from @metaobjectsdev/codegen-ts directly; this alias repairs
  // EXISTING scaffolds that still import bare "ts-poet". In a flat single-tree
  // install the alias resolves to the copy the project would load anyway (no-op).
  // Gated by test/gen-split-tree-single-import.test.ts.
  const codegenTsResolved = aliasMap[CODEGEN_TS_PKG];
  if (codegenTsResolved !== undefined) {
    try {
      aliasMap[TS_POET_PKG] = createRequire(codegenTsResolved).resolve(TS_POET_PKG);
    } catch { /* no ts-poet adjacent to codegen-ts — leave project resolution in place */ }
  }

  // Pre-process the config file content to rewrite @metaobjectsdev/* import
  // specifiers to resolved absolute paths. This is the primary mechanism that
  // ensures the CLI's own copies are used: jiti's `alias` map is kept below as
  // a belt-and-suspenders fallback for runtimes where jiti's transformer IS
  // active, but under Bun the pre-processed source is the operative fix.
  const original = await readFile(fullPath, "utf8");
  const removed = removedGeneratorImportError(original);
  if (removed !== undefined) throw new Error(removed);
  const processed = rewriteImportSpecifiers(original, aliasMap);

  // When any specifiers were rewritten, write the modified source to a temp
  // file in the SAME directory as the original so that relative imports inside
  // the config (e.g. `from "./codegen/generators/entity"`) still resolve
  // correctly. The file is deleted in the finally block below.
  let loadPath = fullPath;
  let tempCreated = false;
  if (processed !== original) {
    const tempName = `${PROC_TEMP_PREFIX}${randomBytes(4).toString("hex")}.ts`;
    const tempPath = resolve(dirname(fullPath), tempName);
    try {
      await writeFile(tempPath, processed, "utf8");
      loadPath = tempPath;
      tempCreated = true;
    } catch {
      // Temp write failed — fall back to the original file and let the loader
      // attempt its own resolution (best-effort; may still fail in hostile envs).
      loadPath = fullPath;
    }
  }

  // jiti's alias map is a belt-and-suspenders fallback for runtimes where
  // jiti's own transformer is active (non-Bun, or a future jiti version that
  // re-enables alias under Bun). Under Bun the pre-processed file above is the
  // operative fix.
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    alias: aliasMap,
  });

  // Global-hooks hygiene. When Bun's native import of the config fails (e.g. a config
  // whose module body throws), jiti falls back to its bundled Babel transformer, whose
  // rewrite-stack-trace PERMANENTLY replaces `Error.prepareStackTrace` with a wrapper
  // delegating to whatever it captured. On Node that captured value is `undefined`, so
  // Babel's own lenient fallback runs and nothing is harmed. On Bun it is Bun's NATIVE
  // default, which throws `TypeError: First argument must be an Error object` for any
  // target that is not a real ErrorInstance — so once the wrapper leaks, every later
  // legacy-constructor error in the process (libsql's `SqliteError` is one:
  // an ES5-style constructor calling `Error.captureStackTrace`) throws that TypeError
  // *while being constructed*, replacing its real message. Snapshot and restore so
  // loading a config can never mutate the process's error hooks.
  const prepareStackTraceBefore = Error.prepareStackTrace;
  const stackTraceLimitBefore = Error.stackTraceLimit;
  try {
    const raw = (await jiti.import(loadPath)) as MetaobjectsGenConfig | { default: MetaobjectsGenConfig };
    // jiti's interopDefault doesn't always unwrap the default export when accessed
    // across module boundaries — explicitly unwrap if present.
    const cfg = (raw && typeof raw === "object" && "default" in raw && raw.default
      ? (raw as { default: MetaobjectsGenConfig }).default
      : raw) as MetaobjectsGenConfig;
    if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.generators)) {
      throw new Error(`metaobjects.config.ts at ${fullPath} did not export a valid MetaobjectsGenConfig (missing 'generators' array).`);
    }
    // An unknown `libraries` name is a hard config error naming the valid ones, while
    // `librarySources` keeps skipping one silently for a programmatic caller. The two
    // are deliberately different: an API caller asking for a package this version does
    // not ship should still be able to load its own metadata, but a name a human typed
    // into a config file is a mistake worth failing on — skipped, it resurfaces later as
    // ERR_UNRESOLVED_SUPER pointing at the adopter's own metadata, which is the wrong
    // place to send someone looking. Python's `project_config` draws the same line in
    // the same place, and the two ports agreeing here is the point.
    if (cfg.libraries !== undefined && cfg.libraries.length > 0) {
      const { knownLibraryPackages } = await import("@metaobjectsdev/metadata/library");
      const available = knownLibraryPackages();
      const unknown = cfg.libraries.filter((n) => !available.includes(n));
      if (unknown.length > 0) {
        throw new Error(
          `metaobjects.config.ts at ${fullPath}: 'libraries' names unknown package(s) ` +
            `${JSON.stringify(unknown)}; available: ${JSON.stringify(available)}.`,
        );
      }
    }
    return cfg;
  } finally {
    // Restoring is safe: Babel's installer self-neuters after the first call, so
    // dropping its wrapper only costs cosmetic frame-hiding in later Babel diagnostics.
    if (Error.prepareStackTrace !== prepareStackTraceBefore) {
      Error.prepareStackTrace = prepareStackTraceBefore;
    }
    if (Error.stackTraceLimit !== stackTraceLimitBefore) {
      Error.stackTraceLimit = stackTraceLimitBefore;
    }
    if (tempCreated) {
      try { unlinkSync(loadPath); } catch { /* best-effort cleanup */ }
    }
  }
}
