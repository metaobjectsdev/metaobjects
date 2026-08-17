import { code, type Code } from "ts-poet";
import { MetaField, MetaObject } from "@metaobjectsdev/metadata";
import {
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_CURRENCY,
  opsForField,
} from "@metaobjectsdev/metadata";
import { sortableFields } from "./filter-shared.js";
import type { RenderContext } from "../render-context.js";

const NUMBER_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  // currency is integer minor units — coerces as a number on the wire.
  FIELD_SUBTYPE_CURRENCY,
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
    .filter((c) => c.attr(FIELD_ATTR_FILTERABLE) === true && c.name !== exclude);
}

/**
 * `exclude` (FR-017): drop a field from the allowlist. Used by per-subtype TPH
 * allowlists to omit the discriminator — it's pinned by the per-subtype route
 * path, so a client must not filter on it.
 *
 * `ctx` supplies `timestampMode`: under `"date"` a `field.timestamp` column binds a JS
 * `Date`, so its rule carries `dateValues: true` and runtime-ts's filter parser coerces
 * the query-string value with `new Date(...)` rather than binding a string against a
 * Date-typed column (which threw at request time). `ctx.timestampMode` is already
 * normalized to `"string"` for sqlite/D1 at both config choke points, so no dialect
 * branching is needed here. Absent `ctx`, or in the default mode, output is unchanged.
 */
export function renderFilterAllowlist(entity: MetaObject, exclude?: string, ctx?: RenderContext): Code {
  const fields = filterableFields(entity, exclude);
  if (fields.length === 0) {
    return code`
import type { FilterAllowlist } from "@metaobjectsdev/runtime-ts/drizzle-fastify";

export const ${entity.name}FilterAllowlist = {} as const satisfies FilterAllowlist;
`;
  }
  const rows = fields
    .map((f) => {
      // opsForField, not opsForSubType — an int-backed field.enum (@intValueMap)
      // stores as an integer, so `like` (a substring match) is not in its band.
      const ops = opsForField(f).map((o) => JSON.stringify(o)).join(", ");
      const sub = filterSubTypeFor(f.subType);
      // Only field.timestamp is governed by timestampMode — Drizzle types
      // field.date / field.time as strings under every dialect.
      const dateValues = ctx?.timestampMode === "date" && f.subType === FIELD_SUBTYPE_TIMESTAMP
        ? ", dateValues: true as const"
        : "";
      return `  ${f.name}: { ops: [${ops}] as const, subType: ${JSON.stringify(sub)} as const, leadingWildcard: false${dateValues} }`;
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
      const defaultOrder = f.attr(FIELD_ATTR_SORTABLE_DEFAULT_ORDER) as string | undefined;
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
