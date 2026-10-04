// Source-detect helpers — discriminate table-backed entities from value-only
// objects (and other in-memory / transit shapes) by inspecting source.* children.
//
// Used by the entity-file composer to pick a streamlined "value-only" emission
// path for metaobjects that declare no writable relational source. Pure
// metadata-driven, not a typeId discriminator: any object subtype can opt out
// of Drizzle table emission simply by omitting source.rdb.

// Cross-realm safety: identify a source by metamodel type/subType and read its
// writability through the node, never by `instanceof MetaSource`. Two physical
// copies of @metaobjectsdev/metadata make the class check false for a real
// source, and here the consequence is SILENT — the entity reads as "not backed
// by any store", so no Drizzle table, no queries and no routes are emitted for
// it and nothing errors. Mechanism and blast radius: metadata's
// shared/node-guards.ts. Gated by test/source-detect.test.ts ("survives a split
// @metaobjectsdev/metadata tree").
import {
  OBJECT_SUBTYPE_PROJECTION,
  OBJECT_SUBTYPE_REPORT,
  SOURCE_SUBTYPE_RDB,
  isMetaSource,
  isWritableSource,
} from "@metaobjectsdev/metadata";
import type { MetaData, MetaObject } from "@metaobjectsdev/metadata";

/** True when the child is a source.rdb node (subType-scoped — the rdb paradigm only). */
function isRdbSource(child: MetaData): boolean {
  return isMetaSource(child) && child.subType === SOURCE_SUBTYPE_RDB;
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
    if (isWritableSource(child)) return true;
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

/**
 * True for a record whose store MetaObjects does not manage: a concrete object with a primary
 * identity and no `source.*` at all, declared or inherited. A MongoDB collection, a Cassandra
 * table, a Neo4j node or a remote API is modelled this way. #248 gives it no table, queries,
 * routes or migration; the adopter owns its data access.
 *
 * It still has a wire contract, because it is addressable: the identity is what makes a record
 * something a client can create, fetch and PATCH. So the entity module gives it the create and
 * update schemas and the filter/sort allowlists, and no table.
 *
 * Keyed on the identity, not on `object.entity` (#248 removed subtype checks from this
 * decision): ADR-0028 forbids a value object any identity, so values are excluded by
 * construction. The one subtype read is the projection exclusion, and it is ADR-0028's own
 * rule: a projection is read-only because of its subtype, so it has no PATCH surface even when
 * it borrows an identity.
 */
export function isSourcelessEntity(obj: MetaObject): boolean {
  if (obj.isAbstract === true || obj.subType === OBJECT_SUBTYPE_PROJECTION) return false;
  if (obj.primaryIdentity() === undefined) return false;
  // ADR-0039: resolving — a source inherited through extends makes the object persistable.
  return !obj.children().some(isMetaSource);
}

/**
 * True for an `object.report` (FR-044). Plan 1 registers and validates the reporting
 * vocabulary but gives a report no lowering yet, so the runner drops it from the entity
 * set every generator reads — including a report that declares a read-only
 * `source.rdb @kind: view` (R5 allows one), which would otherwise pass every
 * source-keyed gate below and emit an empty projection tier.
 */
export function isReport(obj: MetaObject): boolean {
  return obj.subType === OBJECT_SUBTYPE_REPORT;
}
