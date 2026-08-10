// Source-detect helpers — discriminate table-backed entities from value-only
// objects (and other in-memory / transit shapes) by inspecting source.* children.
//
// Used by the entity-file composer to pick a streamlined "value-only" emission
// path for metaobjects that declare no writable relational source. Pure
// metadata-driven, not a typeId discriminator: any object subtype can opt out
// of Drizzle table emission simply by omitting source.rdb.

import { TYPE_SOURCE, SOURCE_SUBTYPE_RDB } from "@metaobjectsdev/metadata";
import type { MetaData, MetaObject } from "@metaobjectsdev/metadata";

// Cross-realm safety: identify a source structurally (type/subType + the
// writability surface), never by `instanceof MetaSource`.
//
// Two physical copies of @metaobjectsdev/metadata in one process give the
// loader's nodes a different MetaSource class object than this module closes
// over, so `instanceof` is false for a node that is a source.rdb in every
// observable respect — the same class-identity defect that split ts-poet's Code
// objects in 0.21.6. Here the consequence is silent: the entity reads as "not
// backed by any store", so no Drizzle table, no queries and no routes are
// emitted for it, and nothing errors.
//
// `meta gen` aliases @metaobjectsdev/metadata to the CLI's own copy
// (load-metaobjects-config.ts CLI_PKG_PATHS), which closes the split for the CLI
// path — but that alias map does not run when a consumer embeds runGen()
// programmatically, so these helpers do not depend on it. Gated by
// test/source-detect.test.ts ("survives a split @metaobjectsdev/metadata tree").

/** True when the child is a source.rdb node, by structure rather than class identity. */
function isRdbSource(child: MetaData): boolean {
  return child.type === TYPE_SOURCE && child.subType === SOURCE_SUBTYPE_RDB;
}

/**
 * True when the node reports itself writable. Reads the writability surface
 * structurally so a source built by a second copy of the package still answers.
 * A node that cannot answer is not counted as writable (fail-closed — the same
 * outcome the `instanceof` guard produced for a non-source node).
 */
function reportsWritable(child: MetaData): boolean {
  const probe = child as unknown as { isWritable?: () => boolean };
  return typeof probe.isWritable === "function" && probe.isWritable();
}

/**
 * True when the entity declares at least one writable source.rdb child.
 * Discriminates table-backed entities (full Drizzle file: table + Insert/Update
 * schemas + filter allowlists + constants) from value-only objects (TS
 * interface + Zod schema only). Absence of source.rdb means in-memory /
 * transit data — no migration, no ORM table to point at.
 */
export function hasWritableRdbSource(entity: MetaObject): boolean {
  // ADR-0039: resolving — an entity may inherit its writable source.rdb via extends
  // (the JVM port's "entity inheriting its source emitted NOTHING" bug); own-only
  // would suppress the Drizzle table for such an entity.
  for (const child of entity.children()) {
    if (!isRdbSource(child)) continue;
    if (reportsWritable(child)) return true;
  }
  return false;
}

/**
 * True when the object declares (or inherits via extends — ADR-0039 resolving)
 * at least one source.rdb child of ANY kind (writable OR read-only). Zero
 * sources means "not backed by any store" (loader contract,
 * validate-source-roles: zero sources is allowed, means not persisted) — the
 * DB-artifact tier (queries/routes/api-model) must emit nothing for it, exactly
 * as the table tier already refuses to emit a Drizzle table for it
 * (hasWritableRdbSource, above — this is its any-kind sibling).
 */
export function hasAnyRdbSource(entity: MetaObject): boolean {
  // ADR-0039: resolving — same rationale as hasWritableRdbSource.
  for (const child of entity.children()) {
    if (isRdbSource(child)) return true;
  }
  return false;
}
