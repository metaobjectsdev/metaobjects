// ADR-0019 Amendment 1, W4 — the SQLite and D1 tier has no decimal type. A text value with
// NUMERIC affinity is stored as an INTEGER or REAL, keeping only its first 15 significant
// digits, so a `field.decimal` declaring `@precision` above 15 is stored lossily.
// Advisory, never a gate: `meta migrate` warns once per field, on those dialects only.

import {
  FIELD_ATTR_PRECISION,
  FIELD_SUBTYPE_DECIMAL,
  OBJECT_SUBTYPE_ENTITY,
  TYPE_FIELD,
  TYPE_OBJECT,
  type MetaData,
} from "@metaobjectsdev/metadata";

/** Significant digits a SQLite or D1 NUMERIC column keeps exactly. */
export const SQLITE_DECIMAL_EXACT_DIGITS = 15;

const LOSSY_DECIMAL_DIALECTS: readonly string[] = ["sqlite", "d1"];

export interface DecimalPrecisionOptions {
  /** Skip an entity by FQN — imported (dependency) metadata is not the adopter's to fix. */
  skip?: (fqn: string) => boolean;
}

/** One message per `field.decimal` with `@precision` above 15, or [] on any other dialect. */
export function decimalPrecisionWarnings(
  root: MetaData,
  dialect: string,
  opts: DecimalPrecisionOptions = {},
): string[] {
  if (!LOSSY_DECIMAL_DIALECTS.includes(dialect)) return [];
  const out: string[] = [];
  for (const obj of root.children()) {
    if (obj.type !== TYPE_OBJECT || obj.subType !== OBJECT_SUBTYPE_ENTITY || obj.isAbstract) continue;
    const fqn = obj.resolutionKey();
    if (opts.skip?.(fqn) === true) continue;
    // ADR-0039: resolving — fields (and their @precision) inherited via extends count.
    for (const f of obj.children()) {
      if (f.type !== TYPE_FIELD || f.subType !== FIELD_SUBTYPE_DECIMAL) continue;
      const precision = f.attr(FIELD_ATTR_PRECISION);
      if (typeof precision !== "number" || precision <= SQLITE_DECIMAL_EXACT_DIGITS) continue;
      out.push(
        `${fqn}.${f.name} is a decimal with @precision ${precision}, but ${dialect} keeps only ` +
          `${SQLITE_DECIMAL_EXACT_DIGITS} significant digits of a decimal (it stores NUMERIC as an integer or ` +
          `a double). Digits beyond the ${SQLITE_DECIMAL_EXACT_DIGITS}th are lost; use Postgres for exact wide decimals.`,
      );
    }
  }
  return out;
}
