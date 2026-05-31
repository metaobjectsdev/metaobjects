// src/snapshot/store.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Dialect, SchemaSnapshot } from "../types.js";
import { parseSnapshot, serializeSnapshot } from "./serialize.js";

/**
 * Committed reference-snapshot path for a dialect, e.g.
 * `<migrationsDir>/.schema.postgres.json`. d1 shares sqlite's schema, so both
 * map to `.schema.sqlite.json`.
 */
export function snapshotPath(migrationsDir: string, dialect: Dialect): string {
  const d = dialect === "d1" ? "sqlite" : dialect;
  return join(migrationsDir, `.schema.${d}.json`);
}

/** Read + parse the snapshot, or null if the file is absent. */
export async function readSnapshot(path: string): Promise<SchemaSnapshot | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseSnapshot(text);
}

/** Serialize + write the snapshot, creating the parent directory if needed. */
export async function writeSnapshot(path: string, snapshot: SchemaSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeSnapshot(snapshot), "utf8");
}
