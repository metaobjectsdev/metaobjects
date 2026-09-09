import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { relPosix } from "./rel-posix.js";
import { looksBundled } from "./authored-source.js";
import { constructText } from "./jsx-construct.js";

/**
 * F52 — a provider mounted with no `baseUrl` on a project whose `apiPrefix` is not empty.
 *
 * 1.0 moved `$apiPrefix` out of the entity descriptor: a browser's base URL is a
 * DEPLOYMENT fact, so the provider supplies it at runtime. The migration note argues the
 * rename is safe because `<EntityFetcherProvider value={…}>` no longer typechecks — and
 * that is true for the adopter who leaves `value` alone. It says nothing about the
 * adopter who reads the note, renames `value` → `fetcher`, and stops: `baseUrl` is
 * OPTIONAL with default `""`, so that tree compiles clean and every generated hook has
 * quietly lost its `/api` segment. Nothing at the type level can see it, and on the
 * estate where this was found nothing else could either — `vite build` transpiles without
 * typechecking, so `build`, 150 tests and every `meta verify` gate were green over a
 * storefront and an admin app whose entire generated CRUD surface would have 404'd.
 *
 * So this is the only gate that can catch it, and it is a WARNING: `baseUrl` is genuinely
 * optional, a project may serve its API at the origin root, and a prefix can legitimately
 * come from somewhere this scan cannot read. It never touches an exit code.
 *
 * It fires ONLY when `apiPrefix` is non-empty — the `meta init` scaffold sets `""`, which
 * is exactly why the trap is easy to ship: the default-configured project is the one the
 * design was reasoned about.
 */
export interface BaseUrlFinding {
  file: string;
  line: number;
  /** The provider construct found without a base. */
  construct: string;
  message: string;
}

const IGNORE_SEGMENTS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo", ".output",
  "coverage", ".metaobjects", ".wrangler",
]);
const SCAN_EXT = /\.(?:ts|tsx|js|jsx|mjs)$/;
const SKIP_FILE = /(?:\.d\.ts$|\.test\.|\.spec\.)/;

/**
 * The two ways a base is supplied, one per client tier.
 *
 * Matched across the WHOLE opening construct rather than a single line, because a JSX
 * provider is nearly always written multi-line — a per-line rule (which is what the
 * anti-pattern scan uses) would miss the formatting every real codebase has.
 */
const PROVIDERS: readonly { construct: string; open: RegExp; kind: "jsx" | "call" }[] = [
  { construct: "<EntityFetcherProvider>", open: /<EntityFetcherProvider\b/g, kind: "jsx" },
  { construct: "provideEntityFetcher()", open: /provideEntityFetcher\s*\(/g, kind: "call" },
];

function scanFile(rel: string, src: string, apiPrefix: string): BaseUrlFinding[] {
  const out: BaseUrlFinding[] = [];
  for (const { construct, open, kind } of PROVIDERS) {
    open.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = open.exec(src)) !== null) {
      const text = constructText(src, m.index, kind);
      if (/\bbaseUrl\b/.test(text)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      out.push({
        file: rel, line, construct,
        message:
          `${rel}:${line} — ${construct} is mounted with no baseUrl, but this project's ` +
          `apiPrefix is "${apiPrefix}". Every generated hook fetches a path RELATIVE to ` +
          `baseUrl, which defaults to "", so those requests go to the origin root and miss ` +
          `"${apiPrefix}". Pass baseUrl (a literal, or your build's env var). If the API ` +
          `really is served at the root here, this is a false positive — ignore it.`,
      });
    }
  }
  return out;
}

function walk(dir: string, root: string, acc: BaseUrlFinding[], apiPrefix: string): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (IGNORE_SEGMENTS.has(e.name)) continue;
    const abs = join(dir, e.name);
    // Symlinked directories are NOT followed — same as the anti-pattern scan beside it.
    //
    // The first version did follow them, with a comment claiming it "never re-enters
    // one". There was no visited set, so `src/loop -> <root>` produced 41 findings for a
    // single file (`src/loop/src/loop/…`), terminating only because Linux's 40-symlink
    // ELOOP limit made readdirSync throw into the catch below. It also meant a link
    // pointing outside the project — a monorepo sibling, a linked package — got walked on
    // every `meta verify`. A provider reachable only through a symlink is reachable
    // through its real path too, so following them buys nothing and the duplicates
    // inflate the count the header prints.
    if (e.isDirectory()) { walk(abs, root, acc, apiPrefix); continue; }
    if (!SCAN_EXT.test(e.name) || SKIP_FILE.test(e.name)) continue;
    let src: string;
    try { src = readFileSync(abs, "utf8"); } catch { continue; }
    if (!src.includes("EntityFetcher")) continue;
    // A bundle is not authored source: the fix belongs in the file it was built FROM, and
    // an estate whose output directory is `public/` proved that no ignore list guesses the
    // name. See lib/authored-source.ts.
    if (looksBundled(src)) continue;
    acc.push(...scanFile(relPosix(root, abs), src, apiPrefix));
  }
}

/**
 * Scan a project tree for providers mounted without a base.
 *
 * Returns [] when `apiPrefix` is empty — there is nothing to lose then, and warning would
 * fire on every scaffolded project.
 */
export function scanForMissingBaseUrl(root: string, apiPrefix: string): BaseUrlFinding[] {
  if (apiPrefix === "") return [];
  const acc: BaseUrlFinding[] = [];
  walk(root, root, acc, apiPrefix);
  return acc;
}
