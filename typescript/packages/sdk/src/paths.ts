import { stat } from "node:fs/promises";
import { join, dirname, resolve, parse } from "node:path";
import type { RecordType } from "./records/core.js";

export function recordPath(
  metaRoot: string,
  type: RecordType,
  id: string,
  opts: { pending?: boolean } = {},
): string {
  const segments = opts.pending
    ? ["memory", "_pending", type, `${id}.json`]
    : ["memory", type, `${id}.json`];
  return join(metaRoot, ...segments);
}

export async function resolveMetaRoot(startDir: string): Promise<string> {
  let current = resolve(startDir);
  const root = parse(current).root;
  while (current !== root) {
    const candidate = join(current, ".meta");
    try {
      const s = await stat(candidate);
      if (s.isDirectory()) return candidate;
    } catch {
      // not present at this level
    }
    current = dirname(current);
  }
  throw new Error(`no .meta directory found walking up from ${startDir}`);
}
