import { code, type Code } from "ts-poet";
import { MetaField, MetaObject } from "@metaobjectsdev/metadata";
import {
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_SHORT,
  FIELD_SUBTYPE_BYTE,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  opsForSubType,
} from "@metaobjectsdev/metadata";
import { sortableFields } from "./filter-shared.js";

const NUMBER_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_SHORT,
  FIELD_SUBTYPE_BYTE,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
]);

const DATETIME_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
]);

/** Maps a field subtype to the FilterSubType category used in generated FilterAllowlist. */
function filterSubTypeFor(fieldSubType: string): "string" | "number" | "boolean" | "datetime" {
  if (fieldSubType === FIELD_SUBTYPE_BOOLEAN) return "boolean";
  if (NUMBER_SUBTYPES.has(fieldSubType)) return "number";
  if (DATETIME_SUBTYPES.has(fieldSubType)) return "datetime";
  return "string";
}

function filterableFields(entity: MetaObject, exclude?: string): MetaField[] {
  // fields() returns effective fields, so inherited fields (from extends:/super:) are included in allowlists.
  return entity
    .fields()
    .filter((c) => c.ownAttr(FIELD_ATTR_FILTERABLE) === true && c.name !== exclude);
}

/**
 * `exclude` (FR-017): drop a field from the allowlist. Used by per-subtype TPH
 * allowlists to omit the discriminator — it's pinned by the per-subtype route
 * path, so a client must not filter on it.
 */
export function renderFilterAllowlist(entity: MetaObject, exclude?: string): Code {
  const fields = filterableFields(entity, exclude);
  if (fields.length === 0) {
    return code`
import type { FilterAllowlist } from "@metaobjectsdev/runtime-ts/drizzle-fastify";

export const ${entity.name}FilterAllowlist = {} as const satisfies FilterAllowlist;
`;
  }
  const rows = fields
    .map((f) => {
      const ops = opsForSubType(f.subType).map((o) => JSON.stringify(o)).join(", ");
      const sub = filterSubTypeFor(f.subType);
      return `  ${f.name}: { ops: [${ops}] as const, subType: ${JSON.stringify(sub)} as const, leadingWildcard: false }`;
    })
    .join(",\n");
  return code`
import type { FilterAllowlist } from "@metaobjectsdev/runtime-ts/drizzle-fastify";

export const ${entity.name}FilterAllowlist = {
${rows}
} as const satisfies FilterAllowlist;
`;
}

export function renderSortAllowlist(entity: MetaObject, exclude?: string): Code {
  // Sortable = explicit @sortable === true, OR (no @sortable AND @filterable === true).
  // @sortable: false explicitly opts out.
  // Uses shared isSortableField predicate — must stay in sync with renderFilterType.
  // `exclude` (FR-017): per-subtype TPH allowlists omit the discriminator.
  const sortable = sortableFields(entity).filter((f) => f.name !== exclude);
  if (sortable.length === 0) {
    return code`
import type { SortAllowlist } from "@metaobjectsdev/runtime-ts/drizzle-fastify";

export const ${entity.name}SortAllowlist = {} as const satisfies SortAllowlist;
`;
  }
  const rows = sortable
    .map((f) => {
      const defaultOrder = f.ownAttr(FIELD_ATTR_SORTABLE_DEFAULT_ORDER) as string | undefined;
      const rule =
        defaultOrder === "asc" || defaultOrder === "desc"
          ? `{ defaultOrder: ${JSON.stringify(defaultOrder)} as const }`
          : `{}`;
      return `  ${f.name}: ${rule}`;
    })
    .join(",\n");
  return code`
import type { SortAllowlist } from "@metaobjectsdev/runtime-ts/drizzle-fastify";

export const ${entity.name}SortAllowlist = {
${rows}
} as const satisfies SortAllowlist;
`;
}
