import {
  ON_DELETE_DEFAULT_BY_SUBTYPE,
  ON_UPDATE_DEFAULT,
  type MetaObject,
  type MetaReferenceIdentity,
} from "@metaobjectsdev/metadata";
import type { FkAction } from "./types.js";

/**
 * Resolve the referential actions for a foreign key inferred from an
 * identity.reference, by correlating it with a sibling relationship on the
 * same entity (matched on target-entity name).
 *
 * - No correlated relationship → both undefined (no ON DELETE / ON UPDATE clause).
 * - With a relationship: onDelete defaults from the relationship subtype
 *   (composition→cascade, aggregation→set-null, association→restrict);
 *   onUpdate defaults to "cascade". Explicit @onDelete / @onUpdate override.
 * - Resolved "no-action" → undefined: introspection in introspect/{postgres,sqlite}.ts
 *   omits actions when the DB value is "no-action", so the expected side does the same
 *   to keep round-trip diffs clean.
 *
 * If multiple relationships target the same entity (rare), the first one is used.
 *
 * The single `as FkAction` cast in normalize() is safe because REFERENTIAL_ACTIONS
 * (metadata package) and FkAction (migrate-ts/src/types.ts) are the same four-value
 * set: "cascade" | "set-null" | "restrict" | "no-action". The comment in
 * relationship-constants.ts documents this invariant; a test in this file guards it
 * at runtime.
 */
export function resolveReferentialActions(
  entity: MetaObject,
  ref: MetaReferenceIdentity,
): { onDelete: FkAction | undefined; onUpdate: FkAction | undefined } {
  const target = ref.targetEntity;
  if (target === undefined) return { onDelete: undefined, onUpdate: undefined };

  const rel = entity.relationships().find((r) => r.objectRef === target);
  if (rel === undefined) return { onDelete: undefined, onUpdate: undefined };

  const onDeleteRaw = rel.onDelete ?? ON_DELETE_DEFAULT_BY_SUBTYPE[rel.subType];
  const onUpdateRaw = rel.onUpdate ?? ON_UPDATE_DEFAULT;
  return {
    onDelete: normalize(onDeleteRaw),
    onUpdate: normalize(onUpdateRaw),
  };
}

function normalize(a: string | undefined): FkAction | undefined {
  if (a === undefined || a === "no-action") return undefined;
  return a as FkAction;
}
