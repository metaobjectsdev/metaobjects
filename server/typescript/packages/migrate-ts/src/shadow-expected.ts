// shadow-expected.ts — turn a shadow database's catalog into the EXPECTED side of the diff.
//
// On the shadow path drift is the diff of introspect(shadow) against introspect(live): the
// same introspector reads both, so every object in scope (tables, columns and types,
// nullability, defaults, CHECKs, PK/FK/unique constraints and their actions, indexes) is in
// Postgres's own spelling on both sides and no per-shape rule is needed. Model-only knowledge
// stays an INPUT to the same diff rather than a second comparison:
//   - renames, @unmanaged and scope are `diff` arguments, applied as always;
//   - a column's `identity` and a table's/column's `description` are carried over from the
//     model, because the catalog cannot say which spelling of an auto-generated key the model
//     asked for (a legacy `serial` column is deliberately not drift against an `increment` key);
//   - views keep the model's own descriptor, since their drift check is a fingerprint the
//     model computed, not a comparison of Postgres's deparsed body.

import { qualifiedDbName } from "./qualified-name.js";
import type { ExprCanon, ExprCanonProbe, IndexExprCanon } from "./expr-canon.js";
import type { CheckDescriptor, ColumnDefault, ColumnDescriptor, IndexDescriptor, SchemaSnapshot, TableDescriptor } from "./types.js";

/** A shadow database's introspected catalog for `expected`'s run, or `undefined` when none is available. */
export type ShadowSchemaSource = (expected: SchemaSnapshot) => Promise<SchemaSnapshot | undefined>;

/**
 * `expected` re-read from `shadow`: each model table replaced by the shadow's table of the
 * same name (a table the shadow lacks is kept as modelled), with the model-only fields laid back.
 */
export function expectedFromShadow(shadow: SchemaSnapshot, expected: SchemaSnapshot): SchemaSnapshot {
  const byId = new Map(shadow.tables.map((t) => [qualifiedDbName(t), t] as const));
  const tables = expected.tables.map((model): TableDescriptor => {
    const st = byId.get(qualifiedDbName(model));
    if (st === undefined) return model;
    const modelCols = new Map(model.columns.map((c) => [c.name, c] as const));
    const columns = st.columns.map((c): ColumnDescriptor => {
      const m = modelCols.get(c.name);
      return {
        ...c,
        ...(m?.identity !== undefined ? { identity: m.identity } : {}),
        ...(m?.description !== undefined ? { description: m.description } : {}),
      };
    });
    return { ...st, columns, ...(model.description !== undefined ? { description: model.description } : {}) };
  });
  return { ...expected, tables };
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
