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
import { pluralize, toSnakeCase } from "@metaobjectsdev/metadata";
import { emitsInstanceArtifacts } from "../instance-artifacts.js";
import { isTphSubtype } from "../tph.js";
import { effectivePackage } from "../docs-paths.js";
import type { OutputLayout } from "../import-path.js";

// Already promoted to the shared cross-language error-code ledger
// (fixtures/conformance/ERROR-CODES.json) and to TS's own ERROR_CODES array
// (packages/metadata/src/errors.ts) — same promotion ERR_PAYLOAD_NAME_COLLISION
// (ADR-0044) went through, the sibling case this one is modeled on.
export const ERR_COLLECTION_NAME_COLLISION = "ERR_COLLECTION_NAME_COLLISION" satisfies ErrorCode;

/** Where the names live: the layout the entity modules are written in, and whether the run
 *  serves routes. */
export interface CollectionNameScopes {
  /** `flat` (one module directory) or `package` (a directory per metadata package). */
  layout?: OutputLayout;
  /** Whether the REST segments are checked (one app serves every route). Default true. */
  routes?: boolean;
}

/**
 * Refuse two objects that claim one generated name in ONE scope. There is no run-wide rule:
 * a name collides only where the artifact that carries it lives.
 *
 * - The pluralized names (`list<Plural>`, `find<Plural>By…`, the hooks, the Drizzle table
 *   variable) are exports of the entity modules, which share one directory and barrel under
 *   the flat layout and one per metadata package under the package layout.
 * - The REST collection segment is a path one app serves: unique across every routed object.
 *
 * Counted over the objects that emit those names (`emitsInstanceArtifacts`): an abstract or
 * sourceless object emits none, so a layered model's abstract `enterprise::Payer` beside a
 * concrete `core::Payer` takes part in neither scope. A TPH subtype IS included in the module
 * scope: it gets its own `list<Plural>`-style names against the shared base table.
 *
 * Deterministic: the first object to claim a name owns it, and the error names the second.
 */
export function assertNoCollectionNameCollisions(
  entities: readonly MetaObject[],
  scopes: CollectionNameScopes = {},
): void {
  const layout = scopes.layout ?? "flat";
  const ownerOfPlural = new Map<string, MetaObject>();
  for (const obj of entities) {
    if (obj.subType === OBJECT_SUBTYPE_VALUE || !emitsInstanceArtifacts(obj)) continue;
    const plural = pluralize(obj.name);
    const scope = layout === "package" ? (effectivePackage(obj) ?? "") : "";
    const key = `${scope}\u0000${plural}`;
    const existing = ownerOfPlural.get(key);
    if (existing !== undefined && existing.resolutionKey() !== obj.resolutionKey()) {
      throw new Error(
        `${ERR_COLLECTION_NAME_COLLISION}: "${existing.resolutionKey()}" and "${obj.resolutionKey()}" both pluralize ` +
        `to the collection name "${plural}" in one module scope (${scope === "" ? "the entity modules' directory" : `package ${scope}`}; ` +
        `generated hook/query/finder/list names, the collection variable) — rename one entity, or ` +
        `place the modules by package (outputLayout: "package"). Default PHYSICAL table names are ` +
        `unaffected by this rule.`,
      );
    }
    if (existing === undefined) ownerOfPlural.set(key, obj);
  }
  if (scopes.routes !== false) assertNoRouteSegmentCollisions(entities);
}

/**
 * The route half. The REST collection segment is the entity NAME snake_cased and then
 * pluralized (`entity-ui-descriptor.ts`), so `ApiKey` and `APIKey` both serve `/api_keys`
 * while their pluralized PascalCase names differ and pass the check above. Counts only
 * objects that actually get a route: not a value object, not abstract, not sourceless,
 * not a TPH subtype (folded into its base's table and served under the base's route).
 */
function assertNoRouteSegmentCollisions(entities: readonly MetaObject[]): void {
  const ownerOfSegment = new Map<string, MetaObject>();
  for (const obj of entities) {
    if (obj.subType === OBJECT_SUBTYPE_VALUE) continue;
    if (!emitsInstanceArtifacts(obj) || isTphSubtype(obj)) continue;
    const segment = pluralize(toSnakeCase(obj.name));
    const existing = ownerOfSegment.get(segment);
    if (existing !== undefined && existing.resolutionKey() !== obj.resolutionKey()) {
      throw new Error(
        `${ERR_COLLECTION_NAME_COLLISION}: "${existing.resolutionKey()}" and "${obj.resolutionKey()}" both resolve ` +
        `to the REST collection segment "${segment}" — rename one entity so its snake_cased, ` +
        `pluralized route segment is distinct.`,
      );
    }
    if (existing === undefined) ownerOfSegment.set(segment, obj);
  }
}
