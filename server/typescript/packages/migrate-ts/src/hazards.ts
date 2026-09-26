import type { Change, DataHazard } from "./types.js";
import { schemaSpread } from "./schema-spread.js";

/**
 * The data hazard `c` carries, if any: a change that applies to an empty table and fails
 * on a populated one (see {@link DataHazard}). `add-column` and `add-check` only ever
 * target an existing table — a new table's columns and CHECKs ride on its create-table.
 * Used by `diff()` to build `DiffResult.hazards` and by the Postgres emitter, which writes
 * the preparation step above the statement — its own leaf module (like column-default.ts)
 * so the emitter does not reach into the diff hub for it.
 */
export function dataHazardOf(c: Change): DataHazard | undefined {
  switch (c.kind) {
    case "add-column": {
      const col = c.column;
      if (col.nullable || col.default !== undefined || col.identity !== undefined) return undefined;
      return { kind: "add-required-column", table: c.table, ...schemaSpread(c.schema), column: col.name };
    }
    case "change-column-nullable":
      if (c.to) return undefined;
      return { kind: "set-not-null", table: c.table, ...schemaSpread(c.schema), column: c.column };
    case "add-check":
      // Carried through a rename-column: the rows already satisfy the very same rule.
      if (c.carriedByRename === true) return undefined;
      return {
        kind: "add-check", table: c.table, ...schemaSpread(c.schema),
        check: c.check.name, expression: c.check.expression,
      };
    default:
      return undefined;
  }
}
