// Collection-name collision refusal — the single choke point every route/hook/
// DbSet-equivalent generator path goes through (called once, in runGen, over the
// full entity set BEFORE any generator runs).
//
// Two DISTINCT entities/projections pluralizing to the SAME API-surface collection
// name (REST path, generated hook/query/finder/list names, Drizzle collection
// variable name) is reachable from stock metadata now that pluralize() no longer
// doubles an already-plural word: "Address" (not already-plural: legacy-pluralizes
// to "Addresses") and "Addresses" (already-plural: left unchanged, ALSO
// "Addresses") collide, where before the fix they did not ("Addresses" legacy-
// pluralized to "Addresseses"). Silently letting two entities share one collection
// name would mean whichever generator runs second silently wins (or, for a
// generator that declares a named symbol per entity — a Drizzle collection export,
// a TanStack hook — a straight-up duplicate-identifier compile error two files
// downstream of the real cause). This refuses at the one place that can see the
// WHOLE set, with a message naming both entities and the colliding name.

import { type ErrorCode, OBJECT_SUBTYPE_VALUE, type MetaObject } from "@metaobjectsdev/metadata";
import { pluralize } from "@metaobjectsdev/metadata";

// Already promoted to the shared cross-language error-code ledger
// (fixtures/conformance/ERROR-CODES.json) and to TS's own ERROR_CODES array
// (packages/metadata/src/errors.ts) — same promotion ERR_PAYLOAD_NAME_COLLISION
// (ADR-0044) went through, the sibling case this one is modeled on.
export const ERR_COLLECTION_NAME_COLLISION = "ERR_COLLECTION_NAME_COLLISION" satisfies ErrorCode;

/**
 * Refuse a generation run in which two DISTINCT entities/projections pluralize to
 * the same API-surface collection name.
 *
 * Scope: every object EXCEPT `object.value` (a value object never gets a route,
 * hook, or collection variable — it is pure shape, so it cannot collide on any of
 * those). A TPH subtype IS included: it gets its own `list<Plural>`/`find<Plural>`-
 * style generated names against the shared base table, so two subtypes (or a
 * subtype and an unrelated top-level entity) sharing a pluralized name collide on
 * those generated symbols exactly as two top-level entities would.
 *
 * A PURE function of the entity set — never of traversal order: the reported pair
 * is deterministic (first-seen-by-input-order "owner" of a plural; the error is
 * thrown as soon as a second, different entity claims the same plural, so which
 * pair is named depends only on the INPUT ORDER's first collision, matching how
 * `assignEmittedNames` (ADR-0044) reports its own first-detected pair rather than
 * attempting to enumerate every colliding pair in one message).
 */
export function assertNoCollectionNameCollisions(entities: readonly MetaObject[]): void {
  const ownerOfPlural = new Map<string, MetaObject>();
  for (const obj of entities) {
    if (obj.subType === OBJECT_SUBTYPE_VALUE) continue;
    const plural = pluralize(obj.name);
    const existing = ownerOfPlural.get(plural);
    if (existing !== undefined && existing.resolutionKey() !== obj.resolutionKey()) {
      throw new Error(
        `${ERR_COLLECTION_NAME_COLLISION}: "${existing.name}" and "${obj.name}" both pluralize ` +
        `to the API-surface collection name "${plural}" (REST path, generated hook/query/finder/` +
        `list names, DbSet/collection variable name) — rename one entity so its pluralized name ` +
        `is distinct. Default PHYSICAL table names are unaffected by this rule and are not ` +
        `involved in the collision.`,
      );
    }
    if (existing === undefined) ownerOfPlural.set(plural, obj);
  }
}
