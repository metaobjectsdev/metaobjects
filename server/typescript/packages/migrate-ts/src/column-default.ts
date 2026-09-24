import type { ColumnDescriptor } from "./types.js";

/**
 * Strict equality of two column defaults (kind and text). Its own module so the diff and
 * the rename heuristic can both use it without importing each other.
 */
export function columnDefaultsEqual(a: ColumnDescriptor["default"], b: ColumnDescriptor["default"]): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.kind === b.kind && a.value === b.value;
}
