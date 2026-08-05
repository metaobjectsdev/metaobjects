import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmitResult } from "./types.js";

export interface WriteMigrationFlywayOptions {
  /** Flyway migrations dir (e.g. "src/main/resources/db/migration"). Created if missing. */
  dir: string;
  /** Human-readable slug; sanitized to lowercase + underscores. */
  slug: string;
}

export interface WriteMigrationFlywayResult {
  /** Full path to the versioned (V) migration. */
  upPath: string;
  /** Full path to the undo (U) migration. */
  downPath: string;
  /** Assigned version number (e.g. 1, 2, 11). */
  version: number;
}

// Versioned migrations ONLY. Matching [VU] here would let the undo files we
// ourselves emit bump the counter, skipping a version on every run.
//
// A Flyway version may have multiple parts separated by EITHER a dot or an
// underscore (V1.1__ and V1_0__ are both legal; the latter is version 1.0). We
// increment the LEADING integer, so an existing V10.5__ yields V11__. Missing the
// underscore form is not cosmetic: against a dir holding V1_0__init.sql the
// scanner would see nothing versioned, restart at V1, and Flyway — which pads
// versions for comparison, so 1 == 1.0 — would reject the result as a duplicate
// version. That is an un-appliable migration, the failure class this engine
// hardens against elsewhere (#226/#241/#258).
const VERSIONED_RE = /^V(\d+)(?:[._]\d+)*__/;

/**
 * #192 — the ADR-0015 Flyway-prefix output adapter.
 *
 * Emits the engine's already-computed up/down SQL in Flyway's envelope:
 * `V<N>__<slug>.sql` plus `U<N>__<slug>.sql`. Undo is a paid Flyway edition
 * feature — Community IGNORES `U__` files rather than failing on them — so the
 * undo file is inert-but-correct there and becomes live on Teams/Enterprise.
 *
 * Applying is deliberately NOT our job here: Flyway owns apply and its
 * `flyway_schema_history`. The CLI refuses --apply / apply-pending / --rollback
 * under this format rather than desyncing that history.
 */
export async function writeMigrationFlyway(
  result: Pick<EmitResult, "up" | "down">,
  opts: WriteMigrationFlywayOptions,
): Promise<WriteMigrationFlywayResult> {
  await mkdir(opts.dir, { recursive: true });

  const version = await nextVersion(opts.dir);
  const slug = sanitizeSlug(opts.slug);

  const upPath = join(opts.dir, `V${version}__${slug}.sql`);
  const downPath = join(opts.dir, `U${version}__${slug}.sql`);

  await writeFile(upPath, ensureTrailingNewline(result.up), "utf8");
  await writeFile(downPath, ensureTrailingNewline(result.down), "utf8");

  return { upPath, downPath, version };
}

async function nextVersion(dir: string): Promise<number> {
  let entries: string[];
  // Best-effort: dir was just mkdir'd, but in race/permission edge cases the
  // listing can still fail; treat as empty (next version = 1) rather than rethrow.
  try {
    entries = await readdir(dir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".sql")) continue;
    const m = VERSIONED_RE.exec(entry);
    if (!m) continue;
    const n = parseInt(m[1]!, 10);
    if (n > max) max = n;
  }
  return max + 1;
}

// Underscores, NOT hyphens: Flyway renders a description's underscores as
// spaces, so V4__add_program_view.sql is the idiomatic shape. (The D1 adapter
// sanitizes to hyphens for Wrangler; do not copy that here.)
function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .substring(0, 60);
  return cleaned.length > 0 ? cleaned : "migration";
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
