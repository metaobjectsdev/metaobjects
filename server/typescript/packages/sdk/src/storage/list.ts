import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { AnyRecord } from "../records/any.js";
import type { RecordType } from "../records/core.js";
import { recordPath } from "../paths.js";
import { readRecord } from "./read.js";

export interface ListOptions {
  pending?: boolean;
  onInvalid?: (path: string, err: unknown) => void;
}

export async function listRecords(
  metaRoot: string,
  type: RecordType,
  opts: ListOptions = {},
): Promise<AnyRecord[]> {
  const dir = directoryFor(metaRoot, type, opts.pending);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isNoEntError(err)) return [];
    throw err;
  }
  const results: AnyRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = basename(entry, ".json");
    try {
      const rec = await readRecord(metaRoot, type, id, opts.pending ? { pending: true } : {});
      results.push(rec);
    } catch (err) {
      opts.onInvalid?.(join(dir, entry), err);
    }
  }
  return results;
}

function directoryFor(metaRoot: string, type: RecordType, pending?: boolean): string {
  // Re-derive from a sentinel id so we use a single source of truth for layout.
  const sentinelPath = recordPath(metaRoot, type, "__sentinel__", pending ? { pending: true } : {});
  return sentinelPath.slice(0, sentinelPath.length - "__sentinel__.json".length - 1);
}

function isNoEntError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
