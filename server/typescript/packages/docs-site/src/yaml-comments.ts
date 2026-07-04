import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CommentDocs { objectDesc: Map<string, string>; fieldNote: Map<string, string>; }
const clean = (c: string) => c.replace(/^[#\s─═-]+/, "").replace(/[─═]+\s*$/, "").trim();

export function harvestComments(sourceDirs: string[]): CommentDocs {
  const objectDesc = new Map<string, string>(); const fieldNote = new Map<string, string>();
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.ya?ml$/.test(e)) files.push(p); } };
  for (const d of sourceDirs) walk(d);
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    let current: string | undefined;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*-\s*object\.\w+:/);
      if (m) {
        current = undefined;
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const nm = lines[j]!.match(/^\s*name:\s*(\S+)/); if (nm) { current = nm[1]; break; }
        }
        if (current) {
          const desc: string[] = [];
          for (let k = i - 1; k >= 0 && lines[k]!.trim().startsWith("#"); k--) { const c = clean(lines[k]!.trim()); if (c) desc.unshift(c); }
          if (desc.length) objectDesc.set(current, desc.join(" ").replace(/\s+/g, " ").slice(0, 400));
        }
      }
      const fm = lines[i]!.match(/^\s*-\s*field\.\w+:\s*\{\s*name:\s*(\w+)[^}]*\}\s*#\s*(.+)$/);
      if (fm && current) fieldNote.set(`${current}.${fm[1]}`, clean(fm[2]!).slice(0, 160));
    }
  }
  return { objectDesc, fieldNote };
}
