import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { relPosix } from "./rel-posix.js";
import { looksBundled } from "./authored-source.js";
import { constructText, topLevelAttrs } from "./jsx-construct.js";

/**
 * F99 — a provider still mounted with a prop 1.0 renamed away.
 *
 * `<EntityFetcherProvider value={f}>` does not typecheck, and both the migration note and
 * the base-URL advisory beside this one rest a safety argument on that fact. The argument
 * holds only where `tsc` is in the gate chain, and in two of nine adopter estates it was
 * not: `vite build` transpiles without typechecking, and a provider with the wrong prop
 * still RENDERS — its children mount, and nothing fails until a component that actually
 * calls a generated hook runs, in a browser, at which point the fetcher is undefined.
 *
 * One estate lost a round to it, misreading a red render smoke test as the release
 * candidate breaking. The second shipped the identical construct and carried it through a
 * whole pass. Two of nine, same component, same prop — that is a class, and the rename
 * was ours.
 *
 * Unlike the base-URL advisory this fires at ANY `apiPrefix`, because there is no
 * configuration under which the old prop reaches the provider. It is still a WARNING and
 * never touches an exit code: the scan cannot see a re-export or an aliased local
 * component, so it must not be the thing that fails a build.
 */
export interface RemovedPropFinding {
  file: string;
  line: number;
  construct: string;
  /** The prop that no longer exists. */
  prop: string;
  message: string;
}

const IGNORE_SEGMENTS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo", ".output",
  "coverage", ".metaobjects", ".wrangler",
]);
const SCAN_EXT = /\.(?:ts|tsx|js|jsx|mjs)$/;
const SKIP_FILE = /(?:\.d\.ts$|\.test\.|\.spec\.)/;

/**
 * What was renamed, and to what.
 *
 * Deliberately a table of ONE. A rename earns a row here only when an adopter has actually
 * shipped the old spelling past their own gates — the value is in naming the specific
 * construct two estates got wrong, not in mirroring the changelog. `open` also gates the
 * cheap `includes()` prefilter in the walk, so a new row needs its marker adding there.
 */
const RENAMES: readonly {
  construct: string;
  open: RegExp;
  from: string;
  to: string;
  since: string;
}[] = [
  {
    construct: "<EntityFetcherProvider>",
    open: /<EntityFetcherProvider\b/g,
    from: "value",
    to: "fetcher",
    since: "1.0",
  },
];

function scanFile(rel: string, src: string): RemovedPropFinding[] {
  const out: RemovedPropFinding[] = [];
  for (const { construct, open, from, to, since } of RENAMES) {
    open.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = open.exec(src)) !== null) {
      if (!topLevelAttrs(constructText(src, m.index, "jsx")).has(from)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      out.push({
        file: rel, line, construct, prop: from,
        message:
          `${rel}:${line} — ${construct} is mounted with \`${from}\`, which ${since} ` +
          `renamed to \`${to}\`. The provider still renders, so nothing fails until a ` +
          `component calls a generated hook and finds no fetcher. \`tsc --noEmit\` names ` +
          `this exactly; a build that only transpiles does not. Rename ${from} → ${to} — ` +
          `and check baseUrl while you are here, since it is optional and defaults to "".`,
      });
    }
  }
  return out;
}

function walk(dir: string, root: string, acc: RemovedPropFinding[]): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (IGNORE_SEGMENTS.has(e.name)) continue;
    const abs = join(dir, e.name);
    // Symlinked directories are NOT followed — see base-url-advisory.ts for the 41-finding
    // ELOOP this prevents.
    if (e.isDirectory()) { walk(abs, root, acc); continue; }
    if (!SCAN_EXT.test(e.name) || SKIP_FILE.test(e.name)) continue;
    let src: string;
    try { src = readFileSync(abs, "utf8"); } catch { continue; }
    if (!src.includes("EntityFetcherProvider")) continue;
    // A bundle is not authored source (F89) — the fix belongs in the file it was built from.
    if (looksBundled(src)) continue;
    acc.push(...scanFile(relPosix(root, abs), src));
  }
}

/** Scan a project tree for providers still using a prop 1.0 renamed away. */
export function scanForRemovedProps(root: string): RemovedPropFinding[] {
  const acc: RemovedPropFinding[] = [];
  walk(root, root, acc);
  return acc;
}
