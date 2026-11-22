import { flatSurfaceFields } from "@metaobjectsdev/codegen-ts/engine";
import { code, type Code } from "@metaobjectsdev/codegen-ts/engine";
import { MetaField, MetaObject } from "@metaobjectsdev/metadata";
import {
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
  FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_DURATION,
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_LOCAL_TIME,
  opsForField,
} from "@metaobjectsdev/metadata";
import { FILTER_OP_LIKE } from "@metaobjectsdev/metadata/constants";
import { enumValues } from "@metaobjectsdev/codegen-ts/engine";
import { credentialFieldNames, isFilterableField, isSortableField, declaredSortDefaultOrder } from "./filter-shared.js";
import type { RenderContext } from "@metaobjectsdev/codegen-ts/engine";
import { httpRuntimeSpecifier } from "@metaobjectsdev/codegen-ts/engine";
import { DEFAULT_OUTPUT_LAYOUT } from "@metaobjectsdev/codegen-ts/engine";
import { effectivePackage } from "@metaobjectsdev/codegen-ts/engine";

/**
 * Where the allowlist TYPES are imported from — the package, unless an owned generator
 * pointed its render context at the adapter copy `meta eject` placed in the repo
 * (`owned-runtime.ts`). Absent `ctx`, or with no `httpRuntimeImport`, the package: the
 * byte-identical default.
 */
const PACKAGE_DEFAULT = { outputLayout: DEFAULT_OUTPUT_LAYOUT, extStyle: "none" } as const;

function allowlistTypesFrom(entity: MetaObject, ctx: RenderContext | undefined): string {
  return httpRuntimeSpecifier("allowlists", ctx ?? PACKAGE_DEFAULT, effectivePackage(entity));
}

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

/**
 * Field subtypes whose filter values have an exact wire format the coarse FilterSubType
 * cannot express ("datetime" is three formats; a uuid is a "string"). The emitted
 * `format` value IS the subtype name — runtime-ts keys its checks on the same constants.
 */
const VALUE_FORMAT_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_DECIMAL,
  // An ISO-8601 duration: runtime-ts refuses a value that is not one, and the column codec binds
  // the dialect's spelling of it.
  FIELD_SUBTYPE_DURATION,
]);

/** Subtypes whose values are whole numbers — `field.currency` is integer minor units. */
const INTEGER_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_CURRENCY,
]);

/**
 * The `format` / `enumValues` / `instant` / `integer` members of a rule, so runtime-ts's
 * filter parser can refuse a value that cannot be the field's type (`invalid_filter_value`)
 * instead of binding it — a malformed date compared as text on SQLite and silently matched
 * nothing, and `filter[dailyRateCents][gte]=40.5` was a 200. `instant` marks a
 * `field.timestamp` that is NOT `@localTime`: the parser reads a zoneless or date-only bound
 * as UTC, the same rule the generated write schema stores it by. Scalar fields only: an
 * array field's filter value is not one element of the declared type.
 */
function valueShape(f: MetaField): FilterRuleValueShape {
  if (f.resolvedIsArray()) return {};
  if (INTEGER_SUBTYPES.has(f.subType)) return { integer: true };
  if (VALUE_FORMAT_SUBTYPES.has(f.subType)) {
    const instant = f.subType === FIELD_SUBTYPE_TIMESTAMP && f.attr(FIELD_ATTR_LOCAL_TIME) !== true;
    return instant ? { format: f.subType, instant: true } : { format: f.subType };
  }
  if (f.subType === FIELD_SUBTYPE_ENUM) {
    // Member SYMBOLS for string- and int-backed enums alike: an int-backed column's codec
    // maps the symbol to its integer when the value is bound.
    const members = enumValues(f);
    if (members !== undefined && members.length > 0) return { enumValues: members };
  }
  return {};
}

/**
 * Whether `?search` matches this filterable field: the runtime's `searchFields` over the rule
 * this field generates. A text rule (`subType` "string") with no `format` and `like` in its
 * band; a uuid or other formatted string and an int-backed enum take no text match.
 */
export function isSearchField(f: MetaField): boolean {
  return filterSubTypeFor(f.subType) === "string" && valueShape(f).format === undefined && opsForField(f).includes(FILTER_OP_LIKE);
}

/** The optional members of a rule beyond `ops` / `subType` / `leadingWildcard`. */
interface FilterRuleValueShape {
  readonly dateValues?: true;
  readonly format?: string;
  readonly instant?: true;
  readonly integer?: true;
  readonly enumValues?: readonly string[];
}

/**
 * One field's filter rule, as data: what `<Entity>FilterAllowlist` carries for it. The
 * runtime-ts `FilterFieldRule` shape, kept structural here so codegen does not depend on
 * the runtime package.
 */
export interface FilterAllowlistRule extends FilterRuleValueShape {
  readonly ops: readonly string[];
  readonly subType: "string" | "number" | "boolean" | "datetime";
  readonly leadingWildcard: false;
}

/** One sortable field's rule, as data: what `<Entity>SortAllowlist` carries for it. */
export interface SortAllowlistRule {
  readonly defaultOrder?: "asc" | "desc";
}

function filterableFields(entity: MetaObject, exclude: string | undefined, ctx: RenderContext | undefined): MetaField[] {
  // fields() returns effective fields, so inherited fields (from extends:/super:) are included in allowlists.
  // A credential is never filterable, whatever @filterable says (isFilterableField); a column a
  // sibling subtype of the same table marks as a credential is not either (credentialFieldNames).
  const credentials = credentialFieldNames(entity, ctx?.loadedRoot);
  return flatSurfaceFields(entity)
    .filter((c) => isFilterableField(c) && !credentials.has(c.name) && c.name !== exclude);
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
export function filterAllowlistRules(
  entity: MetaObject,
  exclude?: string,
  ctx?: RenderContext,
): ReadonlyArray<readonly [string, FilterAllowlistRule]> {
  return filterableFields(entity, exclude, ctx).map((f) => {
    // opsForField, not opsForSubType — an int-backed field.enum (@intValueMap)
    // stores as an integer, so `like` (a substring match) is not in its band.
    const rule: FilterAllowlistRule = {
      ops: opsForField(f),
      subType: filterSubTypeFor(f.subType),
      leadingWildcard: false,
      // Only field.timestamp is governed by timestampMode — Drizzle types
      // field.date / field.time as strings under every dialect.
      ...(ctx?.timestampMode === "date" && f.subType === FIELD_SUBTYPE_TIMESTAMP ? { dateValues: true as const } : {}),
      ...valueShape(f),
    };
    return [f.name, rule] as const;
  });
}

/** One rule as the generated allowlist spells it (members in a fixed order, `as const` on each). */
function filterRuleLiteral(rule: FilterAllowlistRule): string {
  const ops = rule.ops.map((o) => JSON.stringify(o)).join(", ");
  let out = `{ ops: [${ops}] as const, subType: ${JSON.stringify(rule.subType)} as const, leadingWildcard: false`;
  if (rule.dateValues) out += ", dateValues: true as const";
  if (rule.integer) out += ", integer: true as const";
  if (rule.format !== undefined) out += `, format: ${JSON.stringify(rule.format)} as const`;
  if (rule.instant) out += ", instant: true as const";
  if (rule.enumValues !== undefined) out += `, enumValues: [${rule.enumValues.map((m) => JSON.stringify(m)).join(", ")}] as const`;
  return `${out} }`;
}

export function renderFilterAllowlist(entity: MetaObject, exclude?: string, ctx?: RenderContext): Code {
  const rules = filterAllowlistRules(entity, exclude, ctx);
  if (rules.length === 0) {
    return code`
import type { FilterAllowlist } from ${JSON.stringify(allowlistTypesFrom(entity, ctx))};

export const ${entity.name}FilterAllowlist = {} as const satisfies FilterAllowlist;
`;
  }
  const rows = rules.map(([name, rule]) => `  ${name}: ${filterRuleLiteral(rule)}`).join(",\n");
  return code`
import type { FilterAllowlist } from ${JSON.stringify(allowlistTypesFrom(entity, ctx))};

export const ${entity.name}FilterAllowlist = {
${rows}
} as const satisfies FilterAllowlist;
`;
}

/** The sortable fields and their rules, as data (what `<Entity>SortAllowlist` carries). */
export function sortAllowlistRules(
  entity: MetaObject,
  exclude?: string,
  ctx?: RenderContext,
): ReadonlyArray<readonly [string, SortAllowlistRule]> {
  // Sortable = explicit @sortable === true, OR (no @sortable AND @filterable === true).
  // @sortable: false explicitly opts out. A credential is never sortable, nor a column a
  // sibling subtype marks as one. `exclude` (FR-017): per-subtype TPH allowlists omit the
  // discriminator.
  const credentials = credentialFieldNames(entity, ctx?.loadedRoot);
  return flatSurfaceFields(entity)
    .filter((f) => isSortableField(f) && !credentials.has(f.name) && f.name !== exclude)
    .map((f) => {
      // The DECLARED order only — an undeclared field stays `{}` so the runtime's own
      // `?? "asc"` remains the single place the fallback is spelled.
      const defaultOrder = declaredSortDefaultOrder(f);
      return [f.name, defaultOrder === undefined ? {} : { defaultOrder }] as const;
    });
}

export function renderSortAllowlist(entity: MetaObject, exclude?: string, ctx?: RenderContext): Code {
  const rules = sortAllowlistRules(entity, exclude, ctx);
  if (rules.length === 0) {
    return code`
import type { SortAllowlist } from ${JSON.stringify(allowlistTypesFrom(entity, ctx))};

export const ${entity.name}SortAllowlist = {} as const satisfies SortAllowlist;
`;
  }
  const rows = rules
    .map(([name, rule]) =>
      `  ${name}: ${rule.defaultOrder === undefined ? "{}" : `{ defaultOrder: ${JSON.stringify(rule.defaultOrder)} as const }`}`)
    .join(",\n");
  return code`
import type { SortAllowlist } from ${JSON.stringify(allowlistTypesFrom(entity, ctx))};

export const ${entity.name}SortAllowlist = {
${rows}
} as const satisfies SortAllowlist;
`;
}
