import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

export function checkLinks(outDir: string, pages: string[]): string[] {
  const errs: string[] = [];
  const idCache = new Map<string, Set<string>>();
  const idsOf = (p: string) => {
    if (!idCache.has(p)) idCache.set(p, new Set([...readFileSync(p, "utf8").matchAll(/id="([^"]+)"/g)].map((m) => m[1]!)));
    return idCache.get(p)!;
  };
  for (const page of pages) {
    const html = readFileSync(join(outDir, page), "utf8");
    for (const m of html.matchAll(/href="([^"]+)"/g)) {
      const href = m[1]!;
      if (/^(https?:|mailto:|#$)/.test(href)) continue;
      const [file = "", anchor] = href.split("#");
      const target = file === "" ? page : normalize(join(dirname(page), file));
      const abs = join(outDir, target);
      if (!existsSync(abs)) { errs.push(`${page} -> ${href}`); continue; }
      if (anchor && !idsOf(abs).has(anchor)) errs.push(`${page} -> ${href}`);
    }
  }
  return errs;
}
