import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ForgeConfig } from "@metaobjects/codegen-ts";

const CONFIG_FILE = "metaforge.config.ts";

// Resolve @metaobjects/codegen-ts from the CLI's own node_modules so that
// forge.config.ts (which lives in the user's project) can import it even
// when the user's project has no direct dependency on the package.
//
// When compiled: import.meta.url is dist/src/lib/load-forge-config.js — four
// levels up (past lib/, src/, dist/) reaches the CLI package root (packages/cli/).
// When run as TS source (e.g. bun test): import.meta.url is src/lib/load-forge-config.ts
// — three levels up (past lib/, src/) reaches the package root.
const _thisFile = fileURLToPath(import.meta.url);
const _isCompiled = _thisFile.includes("/dist/");
const _cliDir = resolve(_thisFile, _isCompiled ? "../../../.." : "../../..");
const _require = createRequire(import.meta.url);
function resolveCliPkg(specifier: string): string {
  // pkg#exports require ESM resolution; strip the subpath and re-append it
  // as a path into dist/ using the exports map convention.
  if (specifier === "@metaobjects/codegen-ts") {
    return resolve(_cliDir, "node_modules/@metaobjects/codegen-ts/dist/index.js");
  }
  if (specifier === "@metaobjects/codegen-ts/generators") {
    return resolve(_cliDir, "node_modules/@metaobjects/codegen-ts/dist/generators/index.js");
  }
  if (specifier === "@metaobjects/codegen-ts-tanstack") {
    return resolve(_cliDir, "node_modules/@metaobjects/codegen-ts-tanstack/dist/index.js");
  }
  if (specifier === "@metaforge/cli") {
    // The CLI package's own compiled entry — @metaforge/cli is this package itself,
    // so we resolve directly from _cliDir rather than through node_modules (which
    // would be a non-existent self-referential symlink).
    return resolve(_cliDir, "dist/src/index.js");
  }
  return _require.resolve(specifier);
}

export async function loadForgeConfig(projectRoot: string): Promise<ForgeConfig> {
  const fullPath = resolve(projectRoot, CONFIG_FILE);
  if (!existsSync(fullPath)) {
    throw new Error(
      `metaforge.config.ts not found at ${fullPath}. Run 'forge init' to scaffold one.`,
    );
  }
  // Use import.meta.url as base so jiti resolves workspace deps (@metaobjects/*)
  // from the CLI's own node_modules, not from the user's project root.
  // The alias map redirects codegen-ts imports to the CLI's own copy so that
  // user projects don't need @metaobjects/codegen-ts as a direct dependency.
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    alias: {
      "@metaobjects/codegen-ts": resolveCliPkg("@metaobjects/codegen-ts"),
      "@metaobjects/codegen-ts/generators": resolveCliPkg("@metaobjects/codegen-ts/generators"),
      "@metaobjects/codegen-ts-tanstack": resolveCliPkg("@metaobjects/codegen-ts-tanstack"),
      "@metaforge/cli": resolveCliPkg("@metaforge/cli"),
    },
  });
  const raw = (await jiti.import(fullPath)) as ForgeConfig | { default: ForgeConfig };
  // jiti's interopDefault doesn't always unwrap the default export when accessed
  // across module boundaries — explicitly unwrap if present.
  const cfg = (raw && typeof raw === "object" && "default" in raw && raw.default
    ? (raw as { default: ForgeConfig }).default
    : raw) as ForgeConfig;
  if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.generators)) {
    throw new Error(`forge.config.ts at ${fullPath} did not export a valid ForgeConfig (missing 'generators' array).`);
  }
  return cfg;
}
