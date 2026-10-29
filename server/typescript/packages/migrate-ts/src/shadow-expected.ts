// shadow-expected.ts — turn a shadow database's catalog into the EXPECTED side of the diff.
//
// On the shadow path drift is the diff of introspect(shadow) against introspect(live): the
// same introspector reads both, so every object in scope (tables, columns and types,
// nullability, defaults, identity, CHECKs, PK/FK/unique constraints and their actions,
// indexes, view bodies, comments) is in Postgres's own spelling on both sides and no
// per-shape rule is needed. Model-only knowledge stays an INPUT to the same diff rather than
// a second comparison: renames, @unmanaged and scope are `diff` arguments, applied as always.
//
// Views keep the model's descriptor as the thing a migration CREATES (its authored body and
// fingerprint stamp); whether a view differs is decided by comparing the shadow's deparsed
// body (`pg_get_viewdef`) with the live one, in `diff`.

import { qualifiedDbName } from "./qualified-name.js";
import type { ExprCanon, ExprCanonProbe, IndexExprCanon } from "./expr-canon.js";
import type { CheckDescriptor, ColumnDefault, ColumnDescriptor, IndexDescriptor, SchemaSnapshot } from "./types.js";

/** A shadow database's introspected catalog for a run, or why none could be had. */
export type ShadowCatalog = { catalog: SchemaSnapshot } | { unavailable: string };

/** Applies `expected` to a scratch database and reads it back (see shadow-canon.ts). */
export type ShadowSchemaSource = (expected: SchemaSnapshot) => Promise<ShadowCatalog>;

/** `expected` re-read from `shadow`: each model table replaced by the shadow's table of the same name. */
export function expectedFromShadow(shadow: SchemaSnapshot, expected: SchemaSnapshot): SchemaSnapshot {
  const byId = new Map(shadow.tables.map((t) => [qualifiedDbName(t), t] as const));
  return { ...expected, tables: expected.tables.map((model) => byId.get(qualifiedDbName(model)) ?? model) };
}

/**
 * The expression-canon answer when `expected` is already Postgres's spelling: each
 * expression is its own canon, so the comparison with the live one is a plain string equality
 * and the string normaliser (which cannot see a precedence change) is never consulted.
 */
export const shadowIdentityProbe: ExprCanonProbe = async (_live, expected) => {
  const checks = new Map<CheckDescriptor, string>(expected.checks.map((c) => [c, c.expression] as const));
  const indexes = new Map<IndexDescriptor, IndexExprCanon>();
  for (const ix of expected.indexes) {
    const canon: IndexExprCanon = {};
    if (ix.expr !== undefined) canon.expr = ix.expr;
    if (ix.where !== undefined) canon.where = ix.where;
    indexes.set(ix, canon);
  }
  const defaults = new Map<ColumnDescriptor, ColumnDefault>();
  for (const col of expected.columns) if (col.default !== undefined) defaults.set(col, col.default);
  const answer: ExprCanon = { checks, indexes, defaults };
  return answer;
};
