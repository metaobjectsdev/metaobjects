// view-column-types.ts — resolve a view's output columns to SqlTypes.
//
// Needed to decide whether a view change is non-destructively REPLACEABLE. Postgres
// permits `CREATE OR REPLACE VIEW` only when the existing output columns are a prefix
// of the new ones on (name, type, position); getting the types wrong would make the
// diff propose an OR REPLACE that Postgres rejects at APPLY time
// ("cannot change data type of view column ..."), aborting the migration mid-flight
// with no plan-time warning. So every resolution failure here degrades to `undefined`
// — "unknown" — which the diff treats as not-replaceable and routes through a gated,
// loud drop+create. Wrong-but-confident is the only outcome we must never produce.

import type { SqlType } from "./sql-type.js";
import { sqlTypeEquals } from "./sql-type.js";
import type { TableDescriptor, ViewColumnDescriptor } from "./types.js";

/** The codegen-side description of a view column: physical, but untyped. */
export type ExpectedViewColumnInput =
  | { kind: "passthrough"; name: string; sourceTable: string; sourceColumn: string }
  | { kind: "aggregate"; name: string; sourceTable: string; sourceColumn: string; agg: string };

/**
 * Can `existing` be turned into `target` with a `CREATE OR REPLACE VIEW`?
 *
 * Postgres permits it only when the new query produces the same columns as the existing
 * view — same names, same types, same order — with additions allowed at the END.
 * Formally: `existing` must be a PREFIX of `target`.
 * https://www.postgresql.org/docs/current/sql-createview.html
 *
 * Used in BOTH directions. Forward (target = expected, existing = live) it decides
 * replace-vs-drop. Backward, in a down migration (target = the old view, existing = the
 * one we just created), it decides the same thing — and usually says NO, because undoing
 * an append means REMOVING a column, which OR REPLACE cannot do.
 *
 * Fails SAFE: unknown columns on either side → false → the caller uses drop+create.
 * A wrong "yes" is not a failed check, it is a statement Postgres rejects at APPLY time,
 * aborting the migration with no plan-time warning.
 */
export function viewReplaceIsLegal(
  target: readonly ViewColumnDescriptor[] | undefined,
  existing: readonly ViewColumnDescriptor[] | undefined,
): boolean {
  if (target === undefined || existing === undefined) return false;
  if (existing.length > target.length) return false;
  return existing.every((ec, i) => {
    const tc = target[i]!;
    return ec.name === tc.name && sqlTypeEquals(ec.sqlType, tc.sqlType);
  });
}

/**
 * Postgres aggregate result types. Not the argument type — `count(int)` is bigint and
 * `avg(int)` is numeric — so a naive "same as input" rule would mis-type the column and
 * mis-plan the replace.
 *
 * https://www.postgresql.org/docs/current/functions-aggregate.html
 */
function aggregateResultType(agg: string, arg: SqlType | undefined): SqlType | undefined {
  switch (agg) {
    // count() is bigint regardless of its argument — it need not even resolve.
    case "count":
      return { kind: "integer", bits: 64 };
    case "min":
    case "max":
      return arg; // same as the argument type
    case "sum":
      if (arg === undefined) return undefined;
      if (arg.kind === "integer") {
        // smallint/integer → bigint; bigint → numeric (sum can overflow).
        return arg.bits === 64 ? { kind: "numeric" } : { kind: "integer", bits: 64 };
      }
      // numeric → numeric, real → real, double → double.
      if (arg.kind === "numeric" || arg.kind === "real" || arg.kind === "real4") return arg;
      return undefined;
    case "avg":
      if (arg === undefined) return undefined;
      if (arg.kind === "integer" || arg.kind === "numeric") return { kind: "numeric" };
      if (arg.kind === "real" || arg.kind === "real4") return { kind: "real" };
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Resolve every view column against the expected TABLE descriptors.
 *
 * Returns undefined if ANY column cannot be resolved — a partial list is worse than
 * none, because the prefix comparison would silently compare the wrong positions.
 */
export function resolveViewColumns(
  inputs: readonly ExpectedViewColumnInput[] | undefined,
  tables: readonly TableDescriptor[],
): ViewColumnDescriptor[] | undefined {
  if (inputs === undefined || inputs.length === 0) return undefined;

  const byTable = new Map(tables.map((t) => [t.name, t] as const));
  const columnType = (table: string, column: string): SqlType | undefined =>
    byTable.get(table)?.columns.find((c) => c.name === column)?.sqlType;

  const out: ViewColumnDescriptor[] = [];
  for (const input of inputs) {
    const arg = columnType(input.sourceTable, input.sourceColumn);
    const sqlType = input.kind === "aggregate"
      ? aggregateResultType(input.agg, arg)
      : arg;
    if (sqlType === undefined) return undefined;
    out.push({ name: input.name, sqlType });
  }
  return out;
}
