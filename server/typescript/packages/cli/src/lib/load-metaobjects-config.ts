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
// Each aliased specifier maps to a compiled-output path and a TS-source path,
// relative to _cliDir. When running from compiled output we resolve into the
// package's dist/; when running TS source directly (bun test, `meta` run from
// the workspace) we resolve into src/ so the CLI never depends on a stale,
// unrebuilt dist/.
//
// The three workspace deps resolve through the CLI's own node_modules.
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
  "@metaobjectsdev/codegen-ts-tanstack": {
    dist: "node_modules/@metaobjectsdev/codegen-ts-tanstack/dist/index.js",
    src: "node_modules/@metaobjectsdev/codegen-ts-tanstack/src/index.ts",
  },
  "@metaobjectsdev/cli": {
    dist: "dist/src/index.js",
    src: "src/index.ts",
  },
};

function resolveCliPkg(specifier: string): string {
  const paths = CLI_PKG_PATHS[specifier];
  if (paths !== undefined) {
    return resolve(_cliDir, _isCompiled ? paths.dist : paths.src);
  }
  return _require.resolve(specifier);
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
