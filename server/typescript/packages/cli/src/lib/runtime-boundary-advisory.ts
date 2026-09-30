import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { OWNED_RUNTIME_DIR, HTTP_RUNTIME_PACKAGE } from "@metaobjectsdev/codegen-ts";

/**
 * Generated code that imports the owned HTTP-adapter copy from OUTSIDE its own
 * workspace package.
 *
 * Since 1.0.9 an ejected `entity` / `routes` / `routes-hono` generator points its output
 * at `codegen/runtime/` (the adapter source `meta eject` copied) by a path relative to
 * the output directory. In a single-package project that is exactly right. In a monorepo
 * whose output sits inside a workspace package (`apps/api/src/generated`), the path climbs
 * out of that package: `tsc` rejects the file (`TS6059 … is not under 'rootDir'`), and the
 * copy's own bare imports (`qs`, `fastify`) do not resolve from the repository root. The
 * `meta gen` run itself is green; the adopter's build is the first thing that disagrees.
 *
 * Found upgrading a pnpm monorepo. This names the package and the two ways out. It is a
 * warning and never changes an exit code.
 */
export interface RuntimeBoundaryFinding {
  /** Project-relative directory of the workspace package the generated file sits in. */
  packageDir: string;
  /** One generated file (project-relative) that crosses the boundary. */
  example: string;
}

const IMPORT_SPEC = /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g;

function nearestPackageDir(fileDir: string, projectRoot: string): string | undefined {
  for (let d = fileDir; ; d = dirname(d)) {
    if (d === projectRoot || !d.startsWith(projectRoot + sep)) return undefined;
    if (existsSync(join(d, "package.json"))) return d;
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

export function findRuntimeBoundaryCrossings(
  projectRoot: string,
  generatedFiles: readonly string[],
): RuntimeBoundaryFinding[] {
  const root = resolve(projectRoot);
  const runtimeRoot = join(root, OWNED_RUNTIME_DIR);
  const byPackage = new Map<string, RuntimeBoundaryFinding>();
  for (const file of generatedFiles) {
    if (!/\.(ts|tsx|mts)$/.test(file) || !existsSync(file)) continue;
    const abs = resolve(file);
    const pkgDir = nearestPackageDir(dirname(abs), root);
    if (pkgDir === undefined || isInside(runtimeRoot, pkgDir) || byPackage.has(pkgDir)) continue;
    const text = readFileSync(abs, "utf8");
    for (const m of text.matchAll(IMPORT_SPEC)) {
      if (isInside(resolve(dirname(abs), m[1]!), runtimeRoot)) {
        byPackage.set(pkgDir, {
          packageDir: relative(root, pkgDir).split(sep).join("/"),
          example: relative(root, abs).split(sep).join("/"),
        });
        break;
      }
    }
  }
  return [...byPackage.values()];
}

export function runtimeBoundaryWarnings(findings: readonly RuntimeBoundaryFinding[]): string[] {
  return findings.map((f) =>
    `generated code in ${f.packageDir}/ imports the owned HTTP adapter from ${OWNED_RUNTIME_DIR}/, ` +
    `outside that workspace package (e.g. ${f.example}); its build will not resolve it. ` +
    `Either keep importing the published adapter — pass \`runtimeImport: "${HTTP_RUNTIME_PACKAGE}"\` ` +
    `to the ejected entity/routes generators — or move ${OWNED_RUNTIME_DIR}/ inside ${f.packageDir}/ ` +
    `and point \`runtimeImport\` at it.`,
  );
}
