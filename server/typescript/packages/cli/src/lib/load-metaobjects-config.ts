import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";

const CONFIG_FILE = "metaobjects.config.ts";

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

// Resolve a codegen specifier to an absolute path for jiti's alias map, so a
// user's metaobjects.config.ts can import @metaobjectsdev/codegen-ts* without
// declaring it directly — the CLI's own copy is used.
//
// Standard module resolution is tried first: it follows whatever node_modules
// layout exists — npm (flat), pnpm (deps as siblings in the virtual store,
// NOT nested under the CLI dir), or bun — and honors the package's export
// conditions. The CLI_PKG_PATHS fallback only kicks in when a specifier isn't
// require-resolvable from the CLI module.
function resolveCliPkg(specifier: string): string {
  const paths = CLI_PKG_PATHS[specifier];
  // The cli self-reference always points at this package's own entry, never a
  // (possibly absent) self-referential node_modules symlink.
  if (specifier === "@metaobjectsdev/cli" && paths !== undefined) {
    return resolve(_cliDir, _isCompiled ? paths.dist : paths.src);
  }
  try {
    return _require.resolve(specifier);
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

export async function loadMetaobjectsConfig(projectRoot: string): Promise<MetaobjectsGenConfig> {
  const fullPath = resolve(projectRoot, CONFIG_FILE);
  if (!existsSync(fullPath)) {
    throw new Error(
      `metaobjects.config.ts not found at ${fullPath}. Run 'meta init' to scaffold one.`,
    );
  }
  // Use import.meta.url as base so jiti resolves workspace deps (@metaobjectsdev/*)
  // from the CLI's own node_modules, not from the user's project root.
  // The alias map redirects codegen-ts imports to the CLI's own copy so that
  // user projects don't need @metaobjectsdev/codegen-ts as a direct dependency.
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    alias: {
      "@metaobjectsdev/codegen-ts": resolveCliPkg("@metaobjectsdev/codegen-ts"),
      "@metaobjectsdev/codegen-ts/generators": resolveCliPkg("@metaobjectsdev/codegen-ts/generators"),
      "@metaobjectsdev/codegen-ts-react": resolveCliPkg("@metaobjectsdev/codegen-ts-react"),
      "@metaobjectsdev/codegen-ts-tanstack": resolveCliPkg("@metaobjectsdev/codegen-ts-tanstack"),
      "@metaobjectsdev/cli": resolveCliPkg("@metaobjectsdev/cli"),
    },
  });
  const raw = (await jiti.import(fullPath)) as MetaobjectsGenConfig | { default: MetaobjectsGenConfig };
  // jiti's interopDefault doesn't always unwrap the default export when accessed
  // across module boundaries — explicitly unwrap if present.
  const cfg = (raw && typeof raw === "object" && "default" in raw && raw.default
    ? (raw as { default: MetaobjectsGenConfig }).default
    : raw) as MetaobjectsGenConfig;
  if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.generators)) {
    throw new Error(`metaobjects.config.ts at ${fullPath} did not export a valid MetaobjectsGenConfig (missing 'generators' array).`);
  }
  return cfg;
}
