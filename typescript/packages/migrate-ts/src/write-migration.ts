import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmitResult } from "./types.js";

export interface WriteMigrationOptions {
  /** Migrations root directory (e.g., ".meta/migrations"). Must already exist. */
  dir: string;
  /** Human-readable slug; sanitized to lowercase + hyphens. */
  slug: string;
  /** Override for the timestamp source (UTC). Defaults to new Date(). */
  now?: Date;
}

export interface WriteMigrationResult {
  /** Absolute path to the per-migration directory created. */
  dir: string;
  /** Path to up.sql. */
  upPath: string;
  /** Path to down.sql. */
  downPath: string;
}

export async function writeMigration(
  result: Pick<EmitResult, "up" | "down">,
  opts: WriteMigrationOptions,
): Promise<WriteMigrationResult> {
  const ts = formatTimestamp(opts.now ?? new Date());
  const slug = sanitizeSlug(opts.slug);
  const migrationDir = join(opts.dir, `${ts}-${slug}`);

  // Create only the per-migration directory (not the root) — root must exist.
  await mkdir(migrationDir, { recursive: false });

  const upPath = join(migrationDir, "up.sql");
  const downPath = join(migrationDir, "down.sql");
  await writeFile(upPath, ensureTrailingNewline(result.up), "utf8");
  await writeFile(downPath, ensureTrailingNewline(result.down), "utf8");

  return { dir: migrationDir, upPath, downPath };
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);                // cap length for sane filesystem use
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
