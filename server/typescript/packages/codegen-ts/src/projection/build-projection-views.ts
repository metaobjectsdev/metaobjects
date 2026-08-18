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
  type MetaRoot,
  type MetaSource,
  isMetaRoot,
  isReadOnlySource,
  isWritableSource,
  SOURCE_KIND_VIEW,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_ORIGIN,
  resolveTableName,
  resolveTableSchema,
} from "@metaobjectsdev/metadata";
import { isProjection, isWriteThrough } from "./projection-detector.js";
import { extractViewSpec, refNamedOwner } from "./extract-view-spec.js";
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
   * `resolutionKey()` of the object that declared this view — the projection, or the
   * write-through entity hosting its own read view. migrate-ts records it as
   * PROVENANCE (never onto the view descriptor, never into the committed snapshot) so
   * a per-command `migrate.scope` can decide ownership on the declaring FQN rather
   * than on the physical view name, which no naming strategy can reverse.
   */
  fqn: string;
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
   *
   * OMITTED for an `@sql` (#208) view: the body is opaque — the tool never parses it,
   * so its output columns are unknown. migrate-ts reads absent columns as "unknown"
   * and fails safe to a gated drop+create instead of an illegal CREATE OR REPLACE.
   */
  columns?: ExpectedViewColumn[];
}

export interface BuildProjectionViewsOptions {
  dialect: "postgres" | "sqlite" | "d1";
  columnNamingStrategy?: ColumnNamingStrategy;
}

export function buildProjectionViews(
  root: MetaData,
  opts: BuildProjectionViewsOptions,
): ExpectedView[] {
  // isMetaRoot, not `instanceof`: under a split @metaobjectsdev/metadata tree the
  // class check rejects a perfectly good root, turning a working build into a throw.
  if (!isMetaRoot(root)) {
    throw new Error("buildProjectionViews: root must be a loaded MetaRoot.");
  }
  // D1 is SQLite at the SQL level.
  const dialect: "postgres" | "sqlite" = opts.dialect === "d1" ? "sqlite" : opts.dialect;
  const columnNamingStrategy = opts.columnNamingStrategy ?? "snake_case";

  // Keyed by resolutionKey() (FQN), NOT bare name — two packages may declare a
  // same-named entity, and the view-spec's join targets are FQN so they bind the exact
  // one (#244). Keying by bare name let a cross-package same-name entity overwrite the map.
  const joinTables: Record<string, string> = {};
  for (const obj of root.objects()) joinTables[obj.resolutionKey()] = resolveTableName(obj);

  const out: ExpectedView[] = [];
  for (const projection of root.objects().filter(isProjection)) {
    // #208 §6 — classify DDL ownership BEFORE viewIsDerived (see classifyReadOnlySource),
    // so an escape-valve view carrying extends-bound identity/fields (pure shape / row
    // identity) is never mis-synthesized into a wrong base-table passthrough SELECT.
    const cls = classifyReadOnlySource(projection);
    if (cls.kind === "skip") continue;
    if (cls.kind === "sql") {
      emitSqlView(projection, cls.source, root, joinTables, out);
      continue;
    }
    // A plain-view projection with no extends anchor and no origin.* is a STANDALONE
    // read-model that hand-authors its own SQL — viewIsDerived returns false and we skip
    // it (feeding it to extractViewSpec throws "cannot derive the base entity", and the
    // CLI calls this unconditionally, so ONE such projection would abort `meta migrate`
    // for the whole model). Codegen already treats this shape as intended in
    // projection-decl.ts ("standalone views hand-author their SQL").
    if (!viewIsDerived(projection)) continue;
    emitViewFor(projection, root, joinTables, dialect, columnNamingStrategy, out);
  }

  // #213 hole 2 — a write-through ENTITY (FR-024 §7 read-view: a writable table
  // source PLUS a non-primary read-only view source, with derived origin.* fields)
  // hosts its OWN view. Emit it through the SAME canonical emitter — "one emitter,
  // two hosts". `isWriteThrough` had zero call sites, so this replica view was never
  // generated or owned by migrate. Unlike a projection there is no extends anchor
  // and no viewIsDerived gate: the entity IS the base (extractViewSpec detects the
  // write-through host), and it always has a derived view to emit. Only a plain
  // `view` read source synthesizes CREATE VIEW DDL — a matview/proc/tableFunction
  // read source is hand-managed, exactly as for projections above.
  for (const entity of root.objects().filter(isWriteThrough)) {
    // #208 §6 — same DDL-ownership classification as the projection loop. Unlike a
    // projection there is no viewIsDerived gate: a write-through entity IS the base and
    // always has a derived view to emit (extractViewSpec detects the write-through host).
    const cls = classifyReadOnlySource(entity);
    if (cls.kind === "skip") continue;
    if (cls.kind === "sql") {
      emitSqlView(entity, cls.source, root, joinTables, out);
      continue;
    }
    emitViewFor(entity, root, joinTables, dialect, columnNamingStrategy, out);
  }
  return out;
}

/**
 * #208 §6 — classify a host's read-only source by DDL OWNERSHIP, BEFORE any derivation
 * decision. Shared by the projection and write-through loops so the ownership rules can
 * never diverge between the two host kinds (the emit TAIL is already shared via emitViewFor).
 *
 *   - no read-only source, OR @unmanaged (external), OR a non-`view` read-only kind →
 *     "skip". The non-view read-only kinds are hand-managed and MUST NOT reach
 *     extractViewSpec:
 *       · storedProc / tableFunction (FR-015) are CALLABLES, base-less → extractViewSpec
 *         throws (and the CLI calls this unconditionally, so one proc crashed migrate);
 *       · materializedView has no CREATE-MATVIEW emit and is invisible to
 *         information_schema.views, so a "managed" matview re-proposes create every run;
 *       · @unmanaged: Flyway / a hand-migration owns the DDL (§7).
 *   - @sql read source → "sql": the author owns a verbatim body (emitSqlView).
 *   - a plain `view` read source → "derive": a tool-synthesized body (the caller applies
 *     its own viewIsDerived / standalone-read-model gate).
 *
 * ADR-0039: own — mirrors isProjection/viewName's own-source classification.
 */
type ReadOnlySourceClass =
  | { kind: "skip" }
  | { kind: "sql"; source: MetaSource }
  | { kind: "derive"; source: MetaSource };

function classifyReadOnlySource(host: MetaObject): ReadOnlySourceClass {
  const source = host.ownChildren().find(isReadOnlySource);
  if (source === undefined) return { kind: "skip" };
  if (source.isUnmanaged) return { kind: "skip" }; // external — Flyway/hand-migration owns it
  if (source.sqlBody !== undefined) return { kind: "sql", source }; // author-supplied body
  if (source.effectiveKind !== SOURCE_KIND_VIEW) return { kind: "skip" }; // matview/proc/tableFunction
  return { kind: "derive", source };
}

/** Extract + emit one host's (projection or write-through entity) view body and
 *  push it onto `out`. The single tail shared by both walks in buildProjectionViews. */
function emitViewFor(
  host: MetaObject,
  root: MetaRoot,
  joinTables: Record<string, string>,
  dialect: "postgres" | "sqlite",
  columnNamingStrategy: ColumnNamingStrategy,
  out: ExpectedView[],
): void {
  const spec = extractViewSpec(host, root, { columnNamingStrategy });
  const baseTableName = joinTables[spec.joinTree.baseEntity];
  if (!baseTableName) return; // unresolved base — skip (loader/codegen surface the error elsewhere)
  const body = emitViewDdl(spec, { dialect, baseTableName, joinTables, bodyOnly: true });
  const schema = resolveTableSchema(host);
  const dependsOn = collectDependsOn(spec, baseTableName, joinTables);
  const columns = collectViewColumns(spec, baseTableName, joinTables);
  out.push({
    name: spec.viewName,
    sql: body,
    dependsOn,
    columns,
    fqn: host.resolutionKey(),
    ...(schema !== undefined ? { schema } : {}),
  });
}

/**
 * #208 §7 — an `@sql` read source declares a hand-written view body. Push it VERBATIM
 * into the exact same `ExpectedView` pipeline the synthesized body rides — almost no
 * new machinery:
 *   - buildExpectedSchema Pass 4 fingerprints `v.sql` (hash of the body);
 *   - emit stamps the COMMENT marker; author re-indentation does not re-stamp;
 *   - `columns` is OMITTED (the body is opaque — the tool never parses it), so the diff
 *     fails safe to a gated drop+create instead of a wrong-but-confident OR REPLACE;
 *   - a pre-existing unstamped view at this name → `replace-view` blocked pending
 *     `migrate --allow adopt-view` (the one-time adoption ceremony).
 * `dependsOn` is derived from the host's own writable table (a write-through host) plus
 * its extends-bound anchor entities (a projection, D7) — no `@dependsOn` attr.
 */
function emitSqlView(
  host: MetaObject,
  source: MetaSource,
  root: MetaRoot,
  joinTables: Record<string, string>,
  out: ExpectedView[],
): void {
  // D4 — v1 migrate lowering accepts @sql only on a plain @kind: view. matview / proc /
  // tableFunction need genuinely new introspection (pg_matviews, pg_get_functiondef,
  // COMMENT-on-matview, a REFRESH story) and stay hand-managed for now — an actionable
  // hard error, same tiering as SQLite's @schema rejection.
  if (source.effectiveKind !== SOURCE_KIND_VIEW) {
    throw new Error(
      `@sql is not yet migrate-managed on @kind: "${source.effectiveKind}" ` +
        `(source of "${host.name}"). Mark the source @unmanaged, or track the ` +
        `matview/callable managed path as a follow-up (#208 D4).`,
    );
  }
  const schema = resolveTableSchema(host);
  const dependsOn = collectSqlDependsOn(host, root, joinTables);
  out.push({
    name: source.physicalName, // FR-016 four-step physical name
    sql: source.sqlBody!, // verbatim — never parsed, never re-wrapped
    dependsOn,
    fqn: host.resolutionKey(),
    // columns OMITTED → "unknown" → gated drop+create fail-safe.
    ...(schema !== undefined ? { schema } : {}),
  });
}

/**
 * The physical tables an `@sql` view depends on. migrate-ts uses this to drop+recreate
 * the view around a column-altering change on a source table (Postgres blocks ALTER on a
 * column a view depends on). Two sources, no `@dependsOn` attr:
 *
 *   - A **write-through host** (a writable table source + an `@sql` read-view source)
 *     reads from its OWN table — its one certain dependency. It has NO extends anchors
 *     (an entity declares its own identity/fields), so without this its `@sql` view's
 *     dependsOn would be empty and a column ALTER on the host table would fail at apply.
 *   - A **projection** `@sql` view's dependencies are its extends-bound anchor tables
 *     (D7 — the `extends` bindings that anchor the read model's shape ARE the dependency
 *     declaration).
 *
 * Deduped. (A table the opaque body JOINs but neither hosts nor anchors is NOT tracked —
 * the deferred `@dependsOn` escape, ADR-0043.)
 */
function collectSqlDependsOn(
  host: MetaObject,
  root: MetaRoot,
  joinTables: Readonly<Record<string, string>>,
): string[] {
  const tables = new Set<string>();
  // The write-through host's own writable table (keyed the way the diff keys descriptors).
  const hasWritableSource = host.ownChildren().some(isWritableSource);
  if (hasWritableSource) {
    const t = joinTables[host.resolutionKey()];
    if (t !== undefined) tables.add(t);
  }
  // Extends-bound anchor tables (a projection's read-model base).
  for (const child of host.ownChildren()) {
    if (child.type !== TYPE_IDENTITY && child.type !== TYPE_FIELD) continue;
    const owner = refNamedOwner(child, root);
    if (owner === undefined) continue;
    const t = joinTables[owner.resolutionKey()];
    if (t !== undefined) tables.add(t);
  }
  return [...tables];
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
