// A projection's EFFECTIVE row scope. `@filter` composes down an `extends` chain
// rather than overriding: a projection that extends a filtered projection keeps the base's row
// scope (a row gate on an abstract base must survive in every extender). Every
// level's own `@filter`, root-most first, ANDed. One reader for the loaders and the view lowering.

import type { MetaData } from "../../shared/meta-data.js";
import { OBJECT_PROJECTION_ATTR_FILTER } from "./object-constants.js";
import { FILTER_COMPOSE_AND } from "../query/query-constants.js";

/**
 * The `@filter` a projection's view applies: its own and every super's, root-most first. One
 * declaration is returned as declared (byte-identical lowering); two or more are ANDed in one
 * flat `{ and: [...] }`. Undefined when no level declares one.
 */
export function effectiveProjectionFilter(projection: MetaData): unknown {
  const levels: unknown[] = [];
  const seen = new Set<MetaData>();
  for (let node: MetaData | undefined = projection; node !== undefined && !seen.has(node); node = node.superData) {
    seen.add(node);
    // ADR-0039: own — each level contributes the @filter declared on it; the resolving read
    // would return only the nearest one, which is the override this composition replaces.
    const own = node.ownAttr(OBJECT_PROJECTION_ATTR_FILTER);
    if (own !== undefined) levels.unshift(own);
  }
  if (levels.length <= 1) return levels[0];
  return { [FILTER_COMPOSE_AND]: levels.flatMap(andMembers) };
}

/** A level that is itself a bare `{ and: [...] }` contributes its members, keeping the AND flat. */
function andMembers(filter: unknown): unknown[] {
  if (typeof filter === "object" && filter !== null && !Array.isArray(filter)) {
    const entries = Object.entries(filter as Record<string, unknown>);
    if (entries.length === 1 && entries[0]![0] === FILTER_COMPOSE_AND && Array.isArray(entries[0]![1])) {
      return entries[0]![1] as unknown[];
    }
  }
  return [filter];
}
