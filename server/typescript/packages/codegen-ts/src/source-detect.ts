// Source-detect helpers — discriminate table-backed entities from value-only
// objects (and other in-memory / transit shapes) by inspecting source.* children.
//
// Used by the entity-file composer to pick a streamlined "value-only" emission
// path for metaobjects that declare no writable relational source. Pure
// metadata-driven, not a typeId discriminator: any object subtype can opt out
// of Drizzle table emission simply by omitting source.rdb.

import { MetaSource } from "@metaobjectsdev/metadata";
import { TYPE_SOURCE, SOURCE_SUBTYPE_RDB } from "@metaobjectsdev/metadata";
import type { MetaObject } from "@metaobjectsdev/metadata";

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
    if (child.type !== TYPE_SOURCE) continue;
    if (child.subType !== SOURCE_SUBTYPE_RDB) continue;
    if (!(child instanceof MetaSource)) continue;
    if (child.isWritable()) return true;
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
    if (child.type !== TYPE_SOURCE) continue;
    if (child.subType !== SOURCE_SUBTYPE_RDB) continue;
    if (!(child instanceof MetaSource)) continue;
    return true;
  }
  return false;
}
