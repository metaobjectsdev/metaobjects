// The single source of expected view descriptors. Walks every projection,
// extracts its ViewSpec, emits the CREATE VIEW DDL via the one canonical emitter
// (emitViewDdl), and returns the view BODY keyed by name — the shape migrate-ts's
// schema-diff/snapshot/drift pipeline expects on the EXPECTED side (it re-wraps the
// body in CREATE VIEW and the diff comparator strips any leading CREATE VIEW).
//
// migrate-ts stays dependency-pure: it never imports codegen-ts. Callers (the CLI,
// integration tests) compute views here and thread them into buildExpectedSchema /
// drift / snapshot as the `views` input. This is the ONE place view SQL is produced.

import {
  type AggregateFunction,
  type MetaData,
  MetaObject,
  MetaRoot,
  MetaSource,
  SOURCE_KIND_VIEW,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_ORIGIN,
  resolveTableName,
  resolveTableSchema,
} from "@metaobjectsdev/metadata";
import { isProjection } from "./projection-detector.js";
import { extractViewSpec } from "./extract-view-spec.js";
import { emitViewDdl } from "./view-ddl-emit.js";
import type { JoinNode, ViewSpec } from "./view-spec.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";

/** Structurally matches migrate-ts's `ViewDescriptor` (name + body sql + optional schema). */
/**
 * One output column of the view, in SELECT order, described PHYSICALLY (table +
 * column, not entity + field).
 *
 * migrate-ts resolves each of these to a `SqlType` against its own expected table
 * descriptors. Deliberately no SqlType here: codegen-ts stays ignorant of migrate
 * concerns, and migrate-ts stays ignorant of metadata traversal — the existing
 * layering (migrate-ts never imports codegen-ts; the CLI threads views in).
 *
 * Postgres allows a non-destructive `CREATE OR REPLACE VIEW` only when the existing
 * output columns are a PREFIX of the new ones (same names, same types, same order).
 * That decision cannot be made without knowing the column list, which is why it is
 * carried here.
 */
export type ExpectedViewColumn =
  | { kind: "passthrough"; name: string; sourceTable: string; sourceColumn: string }
  | { kind: "aggregate"; name: string; sourceTable: string; sourceColumn: string; agg: AggregateFunction };

export interface ExpectedView {
  name: string;
  schema?: string;
  sql: string;
  /**
   * Physical tables this view reads (base + every joined table). The migrate-ts
   * diff uses this to recreate the view when one of its source tables undergoes a
   * column-altering change — postgres blocks ALTER on a column a view depends on,
   * so the view must be dropped before and recreated after.
   */
  dependsOn: string[];
  /**
   * The view's output columns, in SELECT order — i.e. DECLARATION order, since
   * extractViewSpec walks the projection's children in order. That is exactly the
   * order Postgres's OR-REPLACE prefix rule wants: a field appended to the
   * projection lands last, so the change stays non-destructive. (Re-canonicalizing
   * to, say, alphabetical order would be strictly WORSE — it would scatter an
   * appended field into the middle and force a destructive drop+create.)
   */
  columns: ExpectedViewColumn[];
}

export interface BuildProjectionViewsOptions {
  dialect: "postgres" | "sqlite" | "d1";
  columnNamingStrategy?: ColumnNamingStrategy;
}

export function buildProjectionViews(
  root: MetaData,
  opts: BuildProjectionViewsOptions,
): ExpectedView[] {
  if (!(root instanceof MetaRoot)) {
    throw new Error("buildProjectionViews: root must be a loaded MetaRoot.");
  }
  // D1 is SQLite at the SQL level.
  const dialect: "postgres" | "sqlite" = opts.dialect === "d1" ? "sqlite" : opts.dialect;
  const columnNamingStrategy = opts.columnNamingStrategy ?? "snake_case";

  const joinTables: Record<string, string> = {};
  for (const obj of root.objects()) joinTables[obj.name] = resolveTableName(obj);

  const out: ExpectedView[] = [];
  for (const projection of root.objects().filter(isProjection)) {
    // Only PLAIN-VIEW projections produce managed CREATE VIEW DDL. The other
    // read-only kinds must be skipped, not fed to extractViewSpec:
    //   - storedProc / tableFunction (FR-015) are CALLABLES, not views. They are
    //     base-less (no extends-bound identity), so extractViewSpec THROWS for
    //     them — and the CLI calls this function unconditionally, so one proc
    //     projection used to crash `meta migrate` outright.
    //   - materializedView cannot be managed by the migrate pipeline today:
    //     there is no CREATE MATERIALIZED VIEW emit, and PG introspection cannot
    //     even see matviews (information_schema.views excludes them), so a
    //     "managed" matview would re-propose create-view on every run and the
    //     apply would collide with the existing object. Worse, feeding it
    //     through here silently created a PLAIN view under the matview's name.
    //     Matviews are hand-managed, like the documented custom-SQL-view
    //     exception: migrate neither creates nor drops them.
    //   - a STANDALONE read-model — a plain view projection declaring its own
    //     columns, with no origin.* children — is hand-authored SQL too. Codegen
    //     already treats it that way on purpose (see projection-decl.ts: "lets a
    //     standalone read-only view-entity — explicit columns, no `extends` —
    //     generate its read model … standalone views hand-author their SQL").
    //     The SCHEMA path never got that memo: extractViewSpec THREW on it
    //     ("cannot derive the base entity"), and because the CLI calls this
    //     function unconditionally, ONE such projection aborted `meta migrate`
    //     for the ENTIRE model — every other entity included. Same crash class as
    //     the proc projections above. Skip it instead.
    // ADR-0039: own — mirrors isProjection/viewName's own-source classification.
    const readOnlySource = projection.ownChildren().find(
      (c): c is MetaSource => c instanceof MetaSource && c.isReadOnly(),
    );
    if (readOnlySource?.effectiveKind !== SOURCE_KIND_VIEW) continue;
    if (!viewIsDerived(projection)) continue;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy });
    const baseTableName = joinTables[spec.joinTree.baseEntity];
    if (!baseTableName) continue; // unresolved base — skip (loader/codegen surface the error elsewhere)
    const body = emitViewDdl(spec, { dialect, baseTableName, joinTables, bodyOnly: true });
    const schema = resolveTableSchema(projection);
    const dependsOn = collectDependsOn(spec, baseTableName, joinTables);
    const columns = collectViewColumns(spec, baseTableName, joinTables);
    out.push({
      name: spec.viewName,
      sql: body,
      dependsOn,
      columns,
      ...(schema !== undefined ? { schema } : {}),
    });
  }
  return out;
}

/**
 * The SELECT list as PHYSICAL (table, column) pairs, in emitted order.
 *
 * SelectColumn carries a join ALIAS, which means nothing outside this module — so
 * resolve every alias to its physical table first.
 */
function collectViewColumns(
  spec: ViewSpec,
  baseTableName: string,
  joinTables: Readonly<Record<string, string>>,
): ExpectedViewColumn[] {
  const aliasToTable = new Map<string, string>([[spec.joinTree.baseAlias, baseTableName]]);
  const walk = (node: JoinNode): void => {
    const t = joinTables[node.targetEntity];
    if (t) aliasToTable.set(node.alias, t);
    for (const child of node.children) walk(child);
  };
  for (const j of spec.joinTree.joins) walk(j);

  const out: ExpectedViewColumn[] = [];
  for (const c of spec.selectSpec.columns) {
    // #195: the four new origin column kinds (predicateAgg/collectAgg/computed/first) do
    // not resolve to a single (table, column) SqlType via the prefix rule — computed is
    // an expression, first is a correlated subquery, and the array/boolean aggregate
    // result types are richer than the OR-REPLACE prefix check models. Per this module's
    // fail-safe doctrine (unknown → drop+create, never a wrong-but-confident replace),
    // an unknown column drops the whole list so migrate routes through a gated
    // drop+create. Precise native typing is a later phase.
    if (c.kind !== "passthrough" && c.kind !== "aggregate") return [];
    const sourceTable = aliasToTable.get(c.sourceAlias);
    // An unresolvable alias would make the column list a lie, and a wrong list would
    // make the diff propose an ILLEGAL `CREATE OR REPLACE VIEW` that fails at apply.
    // Drop the whole list instead: migrate-ts treats an absent list as "unknown" and
    // fails safe to a gated drop+create.
    if (sourceTable === undefined) return [];
    out.push(
      c.kind === "aggregate"
        ? { kind: "aggregate", name: c.dbColAlias, sourceTable, sourceColumn: c.sourceColumn, agg: c.agg }
        : { kind: "passthrough", name: c.dbColAlias, sourceTable, sourceColumn: c.sourceColumn },
    );
  }
  return out;
}

/**
 * Is this projection's view DERIVED from the model — i.e. does migrate own its DDL?
 *
 * A derived view is synthesized from a BASE entity, and the base is anchored by an
 * `extends` binding on the projection's own identity or one of its own fields (that is
 * exactly what `baseEntityFor` resolves). So:
 *
 *   - ANCHORED (any own identity/field carries `extends`) → derived. Migrate generates
 *     and owns the view. If the anchor is ambiguous, extractViewSpec throws — correctly,
 *     that is a real authoring error.
 *
 *   - NOT anchored, but carries `origin.*` children → the author clearly MEANT a derived
 *     view (an origin says "this column comes from that entity's column") but gave it
 *     nothing to derive FROM. That is a malformed projection: fall through to
 *     extractViewSpec so it throws its actionable message ("declare an extends-bound
 *     identity to anchor the base"). Do NOT silently skip it.
 *
 *   - NOT anchored and NO origins → a STANDALONE read-model: it declares its own columns
 *     and says nothing about where they come from, so there is nothing to synthesize a
 *     body from. Its SQL is hand-authored. Codegen already treats this shape as
 *     legitimate and intended (projection-decl.ts generates its read model and notes
 *     "standalone views hand-author … their SQL") — the schema path simply never agreed,
 *     and threw, which aborted `meta migrate` for the WHOLE model.
 *
 * Trade-off, stated plainly: a hand-authored view is UNMANAGED, so `meta verify --db`
 * cannot drift-check it. That is the same bounded exception the docs already carve out
 * for custom SQL views and matviews — not a new hole. What changes is only that ONE
 * such view no longer blocks migration of every other entity in the tree.
 *
 * ADR-0039: own — a projection's derivation is declared locally; an inherited extends or
 * origin belongs to the parent's own view.
 */
function viewIsDerived(projection: MetaObject): boolean {
  const own = projection.ownChildren();
  const anchored = own.some(
    (c) => (c.type === TYPE_IDENTITY || c.type === TYPE_FIELD) && c.superRef !== undefined,
  );
  if (anchored) return true;
  // Origins without an anchor = malformed, not standalone. Let extractViewSpec say so.
  return own.some(
    (f) => f.type === TYPE_FIELD && f.ownChildren().some((c) => c.type === TYPE_ORIGIN),
  );
}

/** The base table plus every joined table AND every origin.first child table, deduped —
 *  the physical tables the view reads. A `first` column is a correlated subquery, so its
 *  child table is NOT in the join tree (#195) yet the view still depends on it: if the
 *  child's columns change, the view must be dropped+recreated. Missing it would let a
 *  column-altering change on that table fail at apply. */
function collectDependsOn(
  spec: ViewSpec,
  baseTableName: string,
  joinTables: Readonly<Record<string, string>>,
): string[] {
  const tables = new Set<string>([baseTableName]);
  const walk = (node: JoinNode): void => {
    const t = joinTables[node.targetEntity];
    if (t) tables.add(t);
    for (const child of node.children) walk(child);
  };
  for (const j of spec.joinTree.joins) walk(j);
  for (const c of spec.selectSpec.columns) {
    if (c.kind === "first") {
      const t = joinTables[c.childEntity];
      if (t) tables.add(t);
    }
  }
  return [...tables];
}
