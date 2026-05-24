import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmitResult } from "./types.js";

export interface WriteMigrationD1Options {
  /** Migrations dir (e.g., "migrations"). Created if missing. */
  dir: string;
  /** Human-readable slug; sanitized to lowercase + hyphens. */
  slug: string;
}

export interface WriteMigrationD1Result {
  /** Full path to the up SQL file. */
  upPath: string;
  /** Full path to the down sidecar SQL file. */
  downPath: string;
  /** Assigned sequence number (e.g., 1, 2, 10000). */
  sequence: number;
}

const SEQ_RE = /^(\d+)_/;

export async function writeMigrationD1(
  result: Pick<EmitResult, "up" | "down">,
  opts: WriteMigrationD1Options,
): Promise<WriteMigrationD1Result> {
  await mkdir(opts.dir, { recursive: true });
  await mkdir(join(opts.dir, ".down"), { recursive: true });

  const seq = await nextSequence(opts.dir);
  const padded = String(seq).padStart(4, "0");
  const slug = sanitizeSlug(opts.slug);
  const filename = `${padded}_${slug}.sql`;

  const upPath = join(opts.dir, filename);
  const downPath = join(opts.dir, ".down", filename);

  await writeFile(upPath, ensureTrailingNewline(result.up), "utf8");
  await writeFile(downPath, ensureTrailingNewline(result.down), "utf8");

  return { upPath, downPath, sequence: seq };
}

async function nextSequence(dir: string): Promise<number> {
  let entries: string[];
  // Best-effort: dir was just mkdir'd above, but in race/permission edge cases the
  // listing can still fail; treat as empty (next seq = 1) rather than rethrow.
  try {
    entries = await readdir(dir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".sql")) continue;
    const m = SEQ_RE.exec(entry);
    if (!m) continue;
    const n = parseInt(m[1]!, 10);
    if (n > max) max = n;
  }
  return max + 1;
}

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
