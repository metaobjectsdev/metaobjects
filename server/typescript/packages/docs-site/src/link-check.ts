import { readFileSync } from "node:fs";
import { join } from "node:path";
import { posix } from "node:path";

/**
 * The relative links in `pages` that do not land: every `href` that names a file `read` cannot
 * return, or an anchor no `id="…"` in that file carries. One `<page> -> <href>` line each.
 *
 * Paths are `/`-separated and resolved against each other, so the caller picks the space (a
 * site-relative path, or an absolute one with its separators turned to `/`). Absolute URLs,
 * `mailto:`, a bare `#` and root-relative hrefs (served from outside the site, an `assetBase`
 * mirror) are skipped; a query string selects a view on a page and does not name a file.
 */
export function findDanglingLinks(pages: readonly string[], read: (path: string) => string | undefined): string[] {
  const errs: string[] = [];
  const idCache = new Map<string, Set<string>>();
  const idsOf = (p: string, html: string) => {
    if (!idCache.has(p)) idCache.set(p, new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!)));
    return idCache.get(p)!;
  };
  for (const page of pages) {
    const html = read(page) ?? "";
    for (const m of html.matchAll(/href="([^"]+)"/g)) {
      const href = m[1]!;
      if (/^(https?:|mailto:|#$|\/)/.test(href)) continue;
      const [target0 = "", anchor] = href.split("#");
      const file = target0.split("?")[0] ?? "";
      const target = file === "" ? page : posix.normalize(posix.join(posix.dirname(page), file));
      const body = read(target);
      if (body === undefined) { errs.push(`${page} -> ${href}`); continue; }
      if (anchor && !idsOf(target, body).has(anchor)) errs.push(`${page} -> ${href}`);
    }
  }
  return errs;
}

/** {@link findDanglingLinks} over a site written to `outDir`, `pages` relative to it. */
export function checkLinks(outDir: string, pages: string[]): string[] {
  return findDanglingLinks(pages, (p) => {
    try {
      return readFileSync(join(outDir, p), "utf8");
    } catch {
      return undefined;
    }
  });
}
