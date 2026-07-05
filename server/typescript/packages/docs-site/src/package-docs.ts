import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { LinkGraph, fqnOf } from "./link-graph.js";

export interface PackageDoc { title: string; description: string; }

export function harvestPackageDocs(sourceDirs: string[]): Map<string, PackageDoc> {
  const out = new Map<string, PackageDoc>();
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === "_package.yaml") {
        try {
          const y = parse(readFileSync(p, "utf8")) as { metadata?: { package?: string; title?: string; description?: string } };
          const m = y?.metadata;
          if (m?.package) out.set(m.package, { title: String(m.title ?? ""), description: String(m.description ?? "") });
        } catch { /* malformed _package.yaml is skipped; coverage/anomalies surface it elsewhere */ }
      }
    }
  };
  for (const d of sourceDirs) walk(d);
  return out;
}

export function keyEntities(pkg: string, g: LinkGraph, n = 4): { name: string; href: string; inbound: number }[] {
  return g.nodes()
    .filter((dn) => dn.kind === "object" && dn.pkg === pkg && !dn.node.isAbstract)
    .map((dn) => ({ name: dn.name, href: dn.href, inbound: g.refsTo(fqnOf(dn.node)).filter((r) => r.kind !== "extends").length }))
    .sort((a, b) => b.inbound - a.inbound || a.name.localeCompare(b.name))
    .slice(0, n);
}
