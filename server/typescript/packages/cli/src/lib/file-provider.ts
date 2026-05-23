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
    // `group/source` → <baseDir>/group/source<ext>; node:path.join normalizes
    // the embedded "/" separators for the host OS.
    for (const ext of EXTENSIONS) {
      const path = join(this.baseDir, ref) + ext;
      if (existsSync(path)) {
        try {
          return readFileSync(path, "utf8");
        } catch {
          // unreadable — fall through and try the next candidate
        }
      }
    }
    return undefined;
  }
}
