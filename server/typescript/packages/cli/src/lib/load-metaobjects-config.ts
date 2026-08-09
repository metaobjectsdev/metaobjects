import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createJiti } from "jiti";
import type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";

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
const CLI_PKG_PATHS: Record<string, { dist: string; src: string }> = {
  "@metaobjectsdev/codegen-ts": {
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

  // Pre-process the config file content to rewrite @metaobjectsdev/* import
  // specifiers to resolved absolute paths. This is the primary mechanism that
  // ensures the CLI's own copies are used: jiti's `alias` map is kept below as
  // a belt-and-suspenders fallback for runtimes where jiti's transformer IS
  // active, but under Bun the pre-processed source is the operative fix.
  const original = await readFile(fullPath, "utf8");
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
