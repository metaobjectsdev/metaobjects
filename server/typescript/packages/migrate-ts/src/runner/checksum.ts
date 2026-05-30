// src/runner/checksum.ts
import { createHash } from "node:crypto";

/**
 * Content-normalized checksum of a migration's SQL. Normalizes CRLF→LF, strips
 * per-line trailing whitespace, and trims leading/trailing blank lines — so a
 * reformat does not invalidate an applied migration (deliberately less brittle
 * than Flyway's path/whitespace-sensitive hash).
 */
export function contentChecksum(sql: string): string {
  const normalized = sql
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
