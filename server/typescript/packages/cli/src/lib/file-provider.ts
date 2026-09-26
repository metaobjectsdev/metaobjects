// The filesystem template provider for `meta verify` (FR-004 Plan #3, T6).
//
// Maps a 2-layer logical reference (`group/source`) onto a file under a base
// directory, trying a small set of conventional extensions. This is the CLI's
// concrete provider; the render engine itself stays provider-agnostic (it only
// knows the `Provider` interface), so production hosts can swap in an RDB/NoSQL
// provider without touching the engine.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "@metaobjectsdev/render";

const EXTENSIONS = [".mustache", ".txt", ""] as const;

export class FileProvider implements Provider {
  constructor(private readonly baseDir: string) {}

  resolve(ref: string): string | undefined {
    const path = this.pathOf(ref);
    return path === undefined ? undefined : readFileSync(path, "utf8");
  }

  /**
   * The file `ref` resolves to, or undefined. `resolve` reads exactly this file, so a
   * diagnostic that names it names the body that was checked.
   */
  pathOf(ref: string): string | undefined {
    // `group/source` → <baseDir>/group/source<ext>; node:path.join normalizes
    // the embedded "/" separators for the host OS.
    for (const ext of EXTENSIONS) {
      const path = join(this.baseDir, ref) + ext;
      if (existsSync(path)) {
        try {
          readFileSync(path, "utf8");
          return path;
        } catch {
          // unreadable — fall through and try the next candidate
        }
      }
    }
    return undefined;
  }
}

/**
 * The 1-based line of the first mustache tag naming `path` in `text` — `{{path}}`,
 * `{{{path}}}`, `{{& path}}`, `{{#path}}`, `{{^path}}` — trying the full dotted path and then
 * its head segment (a dotted drift is reported on the path, but the tag may open a section on
 * the head). Undefined when no tag matches, e.g. the variable lives in a partial.
 */
export function mustacheTagLine(text: string, path: string): number | undefined {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = path.split(".")[0] ?? path;
  for (const name of path === head ? [path] : [path, head]) {
    const m = new RegExp(`\\{\\{\\{?\\s*[#^&]?\\s*${esc(name)}\\s*\\}`).exec(text);
    if (m !== null) return text.slice(0, m.index).split("\n").length;
  }
  return undefined;
}
