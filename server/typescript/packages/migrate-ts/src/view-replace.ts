// view-replace.ts — can a live Postgres view be changed with `CREATE OR REPLACE VIEW`?
//
// Postgres permits it only when the new query keeps every existing column — same name,
// same type, same collation, same position — and adds columns only at the END. A replace
// that breaks the rule is refused at APPLY time ("cannot change data type of view column
// ..."), aborting the migration with no plan-time warning.
//
// The tool does not predict the answer. The types a query produces are Postgres's to
// decide (an aggregate drops its argument's length, `COALESCE(varchar(40), 'x')` is a bare
// `character varying`, `json` is not `jsonb`), and a prediction that is nearly right plans
// exactly the statement Postgres refuses. So the planner ASKS: it creates the expected
// definition as a temporary view inside a transaction it always rolls back, reads the
// columns Postgres gave it, and compares them with the live view's. A replace is planned
// only on that evidence. With no evidence (no database, no permission, a definition that
// does not compile against the schema as it stands) the plan is DROP + CREATE.
// https://www.postgresql.org/docs/current/sql-createview.html

import type { ViewDescriptor } from "./types.js";

/** One output column of a view exactly as Postgres holds it. */
export interface ExactViewColumn {
  name: string;
  /** `format_type(atttypid, atttypmod)`: `character varying(40)`, `jsonb`, `numeric(9,2)`, `text[]`. */
  type: string;
  /** The column's collation OID; `0` for a type that has none. */
  collation: string;
}

/** What Postgres reports for the two views a replace would involve. */
export interface ViewReplaceEvidence {
  /** The columns the expected definition produces. */
  expected: readonly ExactViewColumn[];
  /** The columns the live view has. */
  live: readonly ExactViewColumn[];
}

/**
 * Ask the database for the columns of `expected` (as it would be created) and of the `live`
 * view it would replace. Resolves `undefined` when the question could not be answered; it
 * never throws and never leaves anything behind.
 */
export type ViewReplaceProbe = (
  expected: ViewDescriptor,
  live: ViewDescriptor,
) => Promise<ViewReplaceEvidence | undefined>;

/**
 * Can a view whose columns are `existing` be turned into one whose columns are `target`
 * with `CREATE OR REPLACE VIEW`? `existing` must be a PREFIX of `target`.
 *
 * Used in both directions. Forward (target = expected, existing = live) it decides
 * replace-vs-drop. Backward (target = the old view, existing = the one the migration
 * created) it decides the same for the down migration, and usually says NO: undoing an
 * appended column means removing one, which a replace cannot do.
 */
export function viewReplaceIsLegal(
  target: readonly ExactViewColumn[],
  existing: readonly ExactViewColumn[],
): boolean {
  if (existing.length === 0 || existing.length > target.length) return false;
  return existing.every((ec, i) => {
    const tc = target[i]!;
    return ec.name === tc.name && ec.type === tc.type && ec.collation === tc.collation;
  });
}
