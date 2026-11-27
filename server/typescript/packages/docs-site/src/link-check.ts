import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, posix } from "node:path";


/** Every relative link on the written pages must name a file under `outDir`, and its anchor an
 *  id on that file. Returns `page -> href` for each that does not. */
export function checkLinks(outDir: string, pages: string[]): string[] {
  const idCache = new Map<string, Set<string>>();
  return checkLinkTargets(pages, (p) => readFileSync(join(outDir, p), "utf8"), (target) => {
    const abs = join(outDir, target);
    if (!existsSync(abs)) return undefined;
    if (!idCache.has(abs)) idCache.set(abs, idsIn(readFileSync(abs, "utf8")));
    return idCache.get(abs)!;
  }, (page, file) => normalize(join(dirname(page), file)));
}

/** The same check over pages held in memory, keyed by site-relative path (the explorer app,
 *  which writes no pages). `files` names the other files the site ships, which a link may name
 *  but whose ids are not checked. */
export function checkLinksInMemory(pages: ReadonlyMap<string, string>, files: ReadonlySet<string> = new Set()): string[] {
  const idCache = new Map<string, Set<string>>();
  return checkLinkTargets([...pages.keys()], (p) => pages.get(p)!, (target) => {
    const html = pages.get(target);
    if (html === undefined) return files.has(target) ? new Set<string>() : undefined;
    if (!idCache.has(target)) idCache.set(target, idsIn(html));
    return idCache.get(target)!;
  }, (page, file) => posix.normalize(posix.join(posix.dirname(page), file)));
}

function idsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!));
}

function checkLinkTargets(
  pages: readonly string[],
  read: (page: string) => string,
  ids: (target: string) => Set<string> | undefined,
  resolve: (page: string, file: string) => string,
): string[] {
  const errs: string[] = [];
  for (const page of pages) {
    const html = read(page);
    for (const m of html.matchAll(/href="([^"]+)"/g)) {
      const href = m[1]!;
      // A root-relative href is served from outside the site (an `assetBase` mirror); the site's
      // own links are all relative.
      if (/^(https?:|mailto:|#$|\/)/.test(href)) continue;
      const [target0 = "", anchor] = href.split("#");
      // A query string selects a view on the page (`map.html?slice=…`); the file is what must exist.
      const file = target0.split("?")[0] ?? "";
      const target = file === "" ? page : resolve(page, file);
      const found = ids(target);
      if (found === undefined) { errs.push(`${page} -> ${href}`); continue; }
      if (anchor && !found.has(anchor)) errs.push(`${page} -> ${href}`);
    }
  }
  return errs;
}
