import type {
  SchemaSnapshot, TableDescriptor, ColumnDescriptor, IndexDescriptor, FkDescriptor,
  ViewDescriptor,
  DependentRelation,
  Change, ChangeStatus, DiffResult, AllowOptions, AmbiguousCallback, Dialect,
  CheckDescriptor,
} from "../types.js";
import type { SqlType } from "../sql-type.js";
import { sqlTypeEquals } from "../sql-type.js";
import { applyStatus } from "./status.js";
import { detectColumnRenames, detectTableRenames } from "./rename-heuristic.js";
import { viewSqlEquals } from "../view-sql-compare.js";
import { viewReplaceIsLegal } from "../view-column-types.js";
import { checkExprEquals, normalizeCheckExpr } from "../check-expr-compare.js";
import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjectsdev/metadata";

export interface DiffArgs {
  expected: SchemaSnapshot;
  actual: SchemaSnapshot;
  allow?: AllowOptions;
  onAmbiguous?: AmbiguousCallback;
  /**
   * Table-name patterns to ignore on both sides of the diff. Tables matching
   * any pattern are excluded from comparison — neither create-table nor
   * drop-table changes are emitted for them, and they're omitted from index/
   * fk passes. Supports exact names and `*` glob wildcards.
   *
   * Defaults to [`__drizzle_migrations`] when omitted so the Drizzle migration-
   * tracking table doesn't surface as a drop. Pass `[]` explicitly to disable
   * the default. Pass additional patterns to extend.
   */
  ignoreTables?: string[];
  /**
   * Restrict the diff to a set of DB schemas. A table whose schema is not in this
   * set is excluded from BOTH sides — neither created/altered nor dropped.
   *
   * When omitted, the scope is **auto-derived from the schemas the expected
   * (metadata) side declares**: the model manages only the schemas it actually
   * mentions, so a table living in a schema the model never declares belongs to
   * another owner (e.g. a downstream app's schema sharing the same database) and is
   * left untouched. This makes per-owner drift gates clean without manual config —
   * a model that declares only `public` ignores a co-located downstream-app schema,
   * and vice versa. Pass an explicit set to override; pass nothing for the smart default.
   *
   * Auto-scoping is skipped when the expected side declares no tables at all
   * (nothing to manage → prior whole-DB behavior is preserved).
   */
  scopeSchemas?: string[];
  /**
   * Qualified physical names (`schema.name`, schema defaulting to Postgres `public`)
   * of DB objects declared `@unmanaged` (#208 §7). Excluded from the ACTUAL side of the
   * diff, so a declared-external table/view is never proposed for drop — silence, not a
   * policy-gated drop. They are already absent from `expected` (skipped in
   * buildExpectedSchema Pass 1 / buildProjectionViews), so no create is proposed either.
   * Net: the tool leaves a declared-external object entirely alone. Compute via
   * `collectUnmanagedNames`; the format matches `tableIdentity`/`viewIdentity`.
   */
  unmanagedNames?: string[];
  /** Dialect; CHECK-constraint evolution on existing tables is emitted for postgres only. */
  dialect?: Dialect;
}

const ALLOWED: ChangeStatus = { state: "allowed" };

/**
 * Default ignore-table patterns. Catches migration-tracking and replication
 * sidecar tables that downstream tools (Drizzle, litestream) create automatically.
 */
const DEFAULT_IGNORE_TABLES: string[] = [
  "__drizzle_migrations",
  "_litestream_*",
];

/**
 * Normalize undefined schema to "public" (Postgres default) for comparison purposes.
 * Allows snapshots from buildExpectedSchema (often undefined) to compare equal to
 * snapshots from introspect (always populated for Postgres).
 *
 * For SQLite (no schema concept), every table has schema=undefined, so this maps
 * all tables to the same "public." prefix — harmless and preserves existing behavior.
 */
function tableIdentity(table: { name: string; schema?: string }): string {
  return (table.schema ?? DEFAULT_DB_SCHEMA_POSTGRES) + "." + table.name;
}

/**
 * Build the optional-schema spread used when constructing Change records.
 * Required because `exactOptionalPropertyTypes: true` rejects explicit `undefined`
 * for an optional field — we either include the key or we don't.
 */
function schemaSpread(schema: string | undefined): { schema?: string } {
  return schema !== undefined ? { schema } : {};
}

function tableMatchesPattern(name: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    return regex.test(name);
  }
  return name === pattern;
}

function shouldIgnoreTable(name: string, patterns: string[]): boolean {
  return patterns.some((p) => tableMatchesPattern(name, p));
}

/**
 * Compares an expected schema (from metadata) against an actual schema (from introspection)
 * and produces the change list to bring actual → expected. Always returns a Promise.
 *
 * Per spec §6.
 *
 * Accepts either the full DiffArgs object, or positional (expected, actual[, opts]) for
 * convenience in tests and simple callers.
 */
export async function diff(args: DiffArgs): Promise<DiffResult>;
export async function diff(expected: SchemaSnapshot, actual: SchemaSnapshot, opts?: Omit<DiffArgs, "expected" | "actual">): Promise<DiffResult>;
export async function diff(
  argsOrExpected: DiffArgs | SchemaSnapshot,
  actualMaybe?: SchemaSnapshot,
  optsMaybe?: Omit<DiffArgs, "expected" | "actual">,
): Promise<DiffResult> {
  // Normalize args.
  const args: DiffArgs = isDiffArgs(argsOrExpected)
    ? argsOrExpected
    : { expected: argsOrExpected, actual: actualMaybe!, ...(optsMaybe ?? {}) };

  const changes: Change[] = [];

  const ignorePatterns = args.ignoreTables ?? DEFAULT_IGNORE_TABLES;

  // Schema scope (see DiffArgs.scopeSchemas): an explicit set, else the schemas the
  // expected/metadata side declares (the smart default — the model owns only the
  // schemas it mentions), else null = no scoping (empty model → prior whole-DB
  // behavior). A table outside the scope is excluded from both sides, so a
  // co-located schema owned by another app is neither dropped nor reported.
  const declaredSchemas = new Set(
    args.expected.tables.map((t) => t.schema ?? DEFAULT_DB_SCHEMA_POSTGRES),
  );
  const scopeSchemas: Set<string> | null =
    args.scopeSchemas !== undefined
      ? new Set(args.scopeSchemas)
      : declaredSchemas.size > 0
        ? declaredSchemas
        : null;
  const inScope = (schema: string | undefined): boolean =>
    scopeSchemas === null || scopeSchemas.has(schema ?? DEFAULT_DB_SCHEMA_POSTGRES);

  // #208 §7 — declared-@unmanaged qualified names. Excluded from the ACTUAL side only:
  // an @unmanaged object is already absent from `expected`, so dropping it from actual
  // too means the diff never proposes create OR drop for it — silence, not a gated drop.
  const unmanaged = new Set(args.unmanagedNames ?? []);

  // Key tables on (schema, name) identity — same table name in different schemas
  // are distinct entities. tableIdentity normalizes undefined → "public".
  const expectedTables = new Map(
    args.expected.tables
      .filter((t) => !shouldIgnoreTable(t.name, ignorePatterns) && inScope(t.schema))
      .map((t) => [tableIdentity(t), t] as const),
  );
  const actualTables = new Map(
    args.actual.tables
      .filter(
        (t) =>
          !shouldIgnoreTable(t.name, ignorePatterns) &&
          inScope(t.schema) &&
          !unmanaged.has(tableIdentity(t)),
      )
      .map((t) => [tableIdentity(t), t] as const),
  );

  // Pass 1: tables present in expected but not actual → create-table + add-index + add-fk
  // Indexes and FKs are separate SQL statements (not part of CREATE TABLE), so they
  // must be emitted as individual changes even for brand-new tables.
  for (const [id, table] of expectedTables) {
    if (!actualTables.has(id)) {
      changes.push({ kind: "create-table", table, ...schemaSpread(table.schema), status: ALLOWED });
      for (const index of table.indexes) {
        changes.push({
          kind: "add-index", table: table.name, ...schemaSpread(table.schema),
          index, status: ALLOWED,
        });
      }
      for (const fk of table.foreignKeys) {
        changes.push({
          kind: "add-fk", table: table.name, ...schemaSpread(table.schema),
          fk, status: ALLOWED,
        });
      }
      // CHECK constraints are inlined into the CREATE TABLE DDL at emit time
      // (both postgres and sqlite support inline CHECK), so they ride on
      // `create-table.table.checks` rather than as separate add-check changes.
      // For brand-new tables no add-check is emitted here; existing-table CHECK
      // evolution (add/drop on tables present on both sides) is handled by
      // diffTableChecks in Pass 2.
    }
  }
  // Pass 1b: tables present in actual but not expected → drop-table
  // Attach _columns side-channel so detectTableRenames can compare column sets.
  for (const [id, t] of actualTables) {
    if (!expectedTables.has(id)) {
      const dropChange: Change & { _columns?: ColumnDescriptor[] } = {
        kind: "drop-table", table: t.name, ...schemaSpread(t.schema), restore: t, status: ALLOWED,
      };
      dropChange._columns = t.columns;
      changes.push(dropChange);
    }
  }

  // Pass 2: tables in both → compare columns/indexes/FKs
  for (const [id, expectedTable] of expectedTables) {
    const actualTable = actualTables.get(id);
    if (!actualTable) continue;
    diffTableColumns(expectedTable, actualTable, changes, args.dialect);
    diffTableIndexes(expectedTable, actualTable, changes);
    diffTableForeignKeys(expectedTable, actualTable, changes, args.dialect);
    // CHECK constraints on existing tables are evolved whenever a dialect is
    // known (postgres: ALTER ADD/DROP CONSTRAINT; sqlite/d1: the emitter routes
    // the check change through recreate-and-copy — checks are create-time-only
    // inline there). Requires `actual.checks` to be populated: pg_constraint
    // introspection, sqlite_master DDL parsing, or the offline snapshot. With
    // no dialect (legacy positional callers) checks stay un-diffed — those
    // callers may hold hand-built snapshots with empty check lists, and
    // diffing them would re-propose every modeled check forever.
    if (args.dialect !== undefined) diffTableChecks(expectedTable, actualTable, changes, args.dialect);
  }

  // Pass 2b: views. Identity is (schema, name). How "changed" is decided is
  // DIALECT-DEPENDENT — see diffViews.
  const expectedViewsInScope = args.expected.views.filter((v) => inScope(v.schema));
  // #208 §7 — a declared-@unmanaged view is dropped from the actual side so it produces
  // no drop-view (it's absent from expected, so no create-view either): full silence.
  const actualViewsInScope = args.actual.views.filter(
    (v) => inScope(v.schema) && !unmanaged.has(viewIdentity(v)),
  );
  diffViews(expectedViewsInScope, actualViewsInScope, changes, args.dialect);

  // Pass 2c: a change that disturbs the table under a view forces the view to be
  // dropped before and recreated after — postgres blocks ALTER on a column a view
  // depends on; sqlite/d1 rebuild the table via recreate-and-copy for column, FK, AND
  // CHECK/enum changes (#243), any of which strands the view. Body-unchanged dependent
  // views get no change from Pass 2b, so this is where they're picked up.
  recreateViewsDependingOnChangedTables(expectedViewsInScope, actualViewsInScope, changes, args.dialect);

  // Any drop-view (from Pass 2b or 2c) that would destroy relations we do NOT manage
  // must say so — a plain DROP fails at apply, and a CASCADE destroys them for good.
  //
  // Deliberately fed the UNSCOPED actual views: CASCADE does not respect our schema
  // scoping. A downstream application's view lives in ITS OWN schema — precisely the
  // schema the model never declares, and therefore the one scoping filters out — and
  // that is exactly the object a cascade must not destroy silently.
  annotateViewDropDependents(args.actual.views, changes);

  // Pass 3: detect table renames BEFORE column renames — so a renamed table's
  // columns are not scanned as orphaned drop/add pairs.
  await detectTableRenames(changes, args.onAmbiguous);
  await detectColumnRenames(changes, args.onAmbiguous);

  // Strip the rename-detection side-channel fields before status assignment / return.
  for (const c of changes) {
    type Aug = Change & { _sqlType?: unknown; _nullable?: unknown; _columns?: unknown };
    delete (c as Aug)._sqlType;
    delete (c as Aug)._nullable;
    delete (c as Aug)._columns;
  }

  applyStatus(changes, args.allow ?? {});
  return { changes, blocked: changes.filter((c) => c.status.state === "blocked") };
}

function isDiffArgs(x: DiffArgs | SchemaSnapshot): x is DiffArgs {
  return "expected" in x && "actual" in x;
}

/**
 * Collapse a SqlType to what SQLite/D1 can PHYSICALLY store, so the diff never
 * reports drift the database could never represent (and thus could never fix).
 *
 * SQLite/D1 has a single text storage class: `json` is stored as TEXT (no native
 * json type), and a `VARCHAR(N)` length is cosmetic — not enforced — so a bounded
 * and an unbounded text column are the same physical column. Both collapse to bare
 * `text`. The tool's own emit round-trips are unaffected (VARCHAR(8) and TEXT both
 * canon to `text`), while a hand-written `TEXT` column now matches maxLength'd /
 * jsonb metadata. Postgres represents both faithfully and is left exact.
 */
function canonTypeForDialect(t: SqlType, dialect: Dialect | undefined): SqlType {
  if (dialect !== "sqlite" && dialect !== "d1") return t;
  if (t.kind === "json") return { kind: "text" };
  if (t.kind === "text" && t.maxLength !== undefined) return { kind: "text" };
  return t;
}

function sqlTypeEqualsForDialect(a: SqlType, b: SqlType, dialect: Dialect | undefined): boolean {
  return sqlTypeEquals(canonTypeForDialect(a, dialect), canonTypeForDialect(b, dialect));
}

function diffTableColumns(
  expected: TableDescriptor,
  actual: TableDescriptor,
  changes: Change[],
  dialect?: Dialect,
): void {
  const table = expected.name;
  const sx = schemaSpread(expected.schema);
  const expectedCols = new Map(expected.columns.map((c) => [c.name, c]));
  const actualCols = new Map(actual.columns.map((c) => [c.name, c]));

  for (const [name, ec] of expectedCols) {
    const ac = actualCols.get(name);
    if (!ac) {
      changes.push({ kind: "add-column", table, ...sx, column: ec, status: ALLOWED });
      continue;
    }
    // Compare type, nullable, default — emit per-aspect change. Type equality is
    // dialect-aware: SQLite/D1 cannot physically represent a VARCHAR length or a
    // native json type, so those distinctions must not read as drift (see
    // canonTypeForDialect). Postgres stays exact.
    if (!sqlTypeEqualsForDialect(ec.sqlType, ac.sqlType, dialect)) {
      changes.push({
        kind: "change-column-type", table, ...sx, column: name,
        from: ac.sqlType, to: ec.sqlType, status: ALLOWED,
      });
    }
    if (ec.nullable !== ac.nullable) {
      changes.push({
        kind: "change-column-nullable", table, ...sx, column: name,
        from: ac.nullable, to: ec.nullable, status: ALLOWED,
      });
    }
    // An `identity: "uuid"` PK's physical DEFAULT is synthesized purely at DDL-emit
    // time (sqlite/d1: `(lower(hex(randomblob(16))))`; postgres: `gen_random_uuid()`)
    // and is deliberately never recorded as a ColumnDefault on the expected side —
    // uuid generation is modeled as `identity`, not `default`. Introspection, however,
    // reads that DEFAULT back off the live table as a real `expr` default, so comparing
    // the two always disagrees — for every uuid-PK table, on every run, with zero
    // metadata changes. On SQLite/D1 the false positive is destructive rather than
    // merely noisy: there is no ALTER COLUMN, so the recreate-and-copy path rebuilds
    // the WHOLE table. Identity-driven values are not ordinary defaults — don't diff
    // them (`increment` gets this implicitly: an AUTOINCREMENT column has no DEFAULT).
    if (ec.identity !== "uuid" && !columnDefaultsEqual(ec.default, ac.default)) {
      const change: Change = {
        kind: "change-column-default", table, ...sx, column: name,
        status: ALLOWED,
        ...(ac.default !== undefined ? { from: ac.default } : {}),
        ...(ec.default !== undefined ? { to: ec.default } : {}),
      };
      changes.push(change);
    }
  }
  for (const [name, ac] of actualCols) {
    if (!expectedCols.has(name)) {
      const dropChange: Change & { _sqlType?: SqlType; _nullable?: boolean } = {
        kind: "drop-column", table, ...sx, column: name, restore: ac, status: ALLOWED,
      };
      dropChange._sqlType = ac.sqlType;
      dropChange._nullable = ac.nullable;
      changes.push(dropChange);
    }
  }
}

function diffTableIndexes(
  expected: TableDescriptor,
  actual: TableDescriptor,
  changes: Change[],
): void {
  const table = expected.name;
  const sx = schemaSpread(expected.schema);
  const expectedIdx = new Map(expected.indexes.map((i) => [i.name, i]));
  const actualIdx = new Map(actual.indexes.map((i) => [i.name, i]));
  for (const [name, ix] of expectedIdx) {
    const a = actualIdx.get(name);
    if (!a) {
      changes.push({ kind: "add-index", table, ...sx, index: ix, status: ALLOWED });
    } else if (!indexEquals(ix, a)) {
      // Index shape changed: drop + add (atomic from caller's perspective).
      // restore = the ACTUAL shape so the down re-creates the original index.
      changes.push({ kind: "drop-index", table, ...sx, index: name, restore: a, status: ALLOWED });
      changes.push({ kind: "add-index", table, ...sx, index: ix, status: ALLOWED });
    }
  }
  for (const [name, ai] of actualIdx) {
    if (!expectedIdx.has(name)) {
      changes.push({ kind: "drop-index", table, ...sx, index: name, restore: ai, status: ALLOWED });
    }
  }
}

/**
 * FK identity key. Postgres stores constraint names, so name IS the identity.
 * SQLite does NOT store FK names at all (the emitter writes unnamed FOREIGN KEY
 * clauses; pragma_foreign_key_list has no name column), so introspection can only
 * SYNTHESIZE a name — which diverges from the expected side for any composite FK
 * (`t_a_fk` vs `t_a_b_fk`) and for every `@constraintName` override, producing a
 * phantom drop-fk/add-fk (and thus a recreate-and-copy, or a permanently blocked
 * migrate) on every run. On sqlite/d1 the FK's real identity is its COLUMN SET:
 * key on that and let fkEquals (which never compares names) catch genuine
 * refTable/refColumns/action changes as drop+add.
 *
 * If the same column set carries two FKs (possible in SQL, never produced by
 * buildExpectedSchema), the map would silently collapse them — fall back to
 * name-keying for that table rather than mis-diff.
 */
function fkColsKey(f: FkDescriptor): string {
  return f.columns.join("\u001f");
}

/**
 * Decide the FK keying mode for a table, considering BOTH sides at once.
 *
 * Structural (column-set) keying is what makes sqlite/d1 converge — the engine stores no
 * FK names, so introspection synthesizes them and they can never match a composite or
 * `@constraintName`-overridden expected name. But the duplicate-column-set fallback MUST
 * be decided jointly: deciding it per side lets one side key by column set while the
 * other keys by (synthesized, colliding) name, so even the FK that genuinely MATCHES
 * mis-diffs into a phantom add + drops of both actual FKs.
 */
function fkKeyingIsStructural(
  expected: readonly FkDescriptor[],
  actual: readonly FkDescriptor[],
  dialect: Dialect | undefined,
): boolean {
  if (dialect !== "sqlite" && dialect !== "d1") return false;
  const distinct = (fks: readonly FkDescriptor[]): boolean =>
    new Set(fks.map(fkColsKey)).size === fks.length;
  // Either side carrying duplicate column sets → structural keying would drop one; both
  // sides fall back to names together.
  return distinct(expected) && distinct(actual);
}

function fkMapFor(
  fks: readonly FkDescriptor[],
  structural: boolean,
): Map<string, FkDescriptor> {
  return new Map(fks.map((f) => [structural ? fkColsKey(f) : f.name, f] as const));
}

function diffTableForeignKeys(
  expected: TableDescriptor,
  actual: TableDescriptor,
  changes: Change[],
  dialect: Dialect | undefined,
): void {
  const table = expected.name;
  const sx = schemaSpread(expected.schema);
  const structuralFk = fkKeyingIsStructural(expected.foreignKeys, actual.foreignKeys, dialect);
  const expectedFk = fkMapFor(expected.foreignKeys, structuralFk);
  const actualFk = fkMapFor(actual.foreignKeys, structuralFk);
  // NOTE: the map key is the FK's identity (name on postgres; column set on
  // sqlite/d1 — see fkMapFor). Change records always carry the DESCRIPTOR's
  // constraint name, never the key.
  for (const [key, fk] of expectedFk) {
    const a = actualFk.get(key);
    if (!a) {
      changes.push({ kind: "add-fk", table, ...sx, fk, status: ALLOWED });
    } else if (!fkEquals(fk, a)) {
      // FK shape changed: drop + add. restore = the ACTUAL shape so the down
      // re-creates the original FK.
      changes.push({ kind: "drop-fk", table, ...sx, fk: a.name, restore: a, status: ALLOWED });
      changes.push({ kind: "add-fk", table, ...sx, fk, status: ALLOWED });
    }
  }
  for (const [key, af] of actualFk) {
    if (!expectedFk.has(key)) {
      changes.push({ kind: "drop-fk", table, ...sx, fk: af.name, restore: af, status: ALLOWED });
    }
  }
}

function diffTableChecks(
  expected: TableDescriptor,
  actual: TableDescriptor,
  changes: Change[],
  dialect?: Dialect,
): void {
  const sx = schemaSpread(expected.schema);
  // SQLite/D1 stores no constraint identity for an inline `CHECK (…)`, so hand-written
  // DDL yields anonymous (empty-name) checks. When an expected named check has no
  // same-name actual, fall back to matching by NORMALIZED EXPRESSION so an
  // already-enforced constraint is not re-proposed as add-check (and its actual is not
  // re-proposed as drop-check). The fallback scans ALL still-unconsumed actual checks,
  // so it also reconciles a name-MISMATCHED actual (a check the DB named differently
  // than the model's generated `<table>_<col>_chk`), not only truly-anonymous ones —
  // beneficial and safe: the name-keyed pass runs first, so a genuine expression change
  // on a name-matched check is still caught as drop+add. Postgres constraints are always
  // named, so it keeps the exact name-keyed behavior (exprFallback off).
  const exprFallback = dialect === "sqlite" || dialect === "d1";
  const actualByName = new Map(actual.checks.filter((c) => c.name !== "").map((c) => [c.name, c]));
  const consumed = new Set<CheckDescriptor>();

  for (const ec of expected.checks) {
    const ac = actualByName.get(ec.name);
    if (ac) {
      consumed.add(ac);
      if (!checkExprEquals(ec.expression, ac.expression)) {
        changes.push({ kind: "drop-check", table: expected.name, ...sx, check: ec.name, restore: ac, status: ALLOWED });
        changes.push({ kind: "add-check", table: expected.name, ...sx, check: ec, status: ALLOWED });
      }
      continue;
    }
    if (exprFallback) {
      const match = actual.checks.find((a) => !consumed.has(a) && checkExprEquals(ec.expression, a.expression));
      if (match) { consumed.add(match); continue; }
    }
    changes.push({ kind: "add-check", table: expected.name, ...sx, check: ec, status: ALLOWED });
  }
  for (const ac of actual.checks) {
    if (consumed.has(ac)) continue;
    changes.push({ kind: "drop-check", table: expected.name, ...sx, check: ac.name, restore: ac, status: ALLOWED });
  }
}

function viewIdentity(v: { name: string; schema?: string }): string {
  return (v.schema ?? DEFAULT_DB_SCHEMA_POSTGRES) + "." + v.name;
}

/**
 * Decide, per view, whether the DB matches the model.
 *
 * TWO comparison strategies, because the engines differ in kind, not degree:
 *
 *   - SQLite/D1 store the view's SQL verbatim, so comparing the normalized body is
 *     exact. Unchanged behavior.
 *
 *   - Postgres stores a PARSE TREE. `pg_get_viewdef()` deparses it into Postgres's own
 *     style (`LEFT OUTER JOIN` → `LEFT JOIN`, parenthesized FROM items, lowercased
 *     functions, dropped aliases), so the text we wrote can NEVER come back. Comparing
 *     it reported a difference every single time — which is exactly why replace-view
 *     fired on every migrate, forever, and why `verify --db` was permanently red for
 *     any project with a projection. Postgres therefore compares FINGERPRINTS: a hash
 *     of the body we generated, stamped into the view's COMMENT at emit time. Both
 *     sides of that comparison come from our emitter; the deparser is never consulted.
 *
 * An unknown dialect keeps the old body comparison (legacy positional callers hold
 * hand-built snapshots; changing their semantics silently is worse than leaving them).
 */
function diffViews(
  expected: ViewDescriptor[], actual: ViewDescriptor[], changes: Change[],
  dialect: Dialect | undefined,
): void {
  const exp = new Map(expected.map((v) => [viewIdentity(v), v] as const));
  const act = new Map(actual.map((v) => [viewIdentity(v), v] as const));

  for (const [id, v] of exp) {
    const a = act.get(id);
    if (a === undefined) {
      changes.push({ kind: "create-view", view: v, ...schemaSpread(v.schema), status: ALLOWED });
      continue;
    }

    if (dialect === "postgres") {
      // No expected fingerprint (an unresolvable projection body) → we cannot prove a
      // change. Leave it alone rather than propose a spurious replace.
      if (v.fingerprint === undefined) continue;

      // The DB view carries no stamp. It is EITHER a view created before fingerprinting
      // existed, OR somebody's hand-written SQL sitting at a projection's name — and on
      // Postgres those are indistinguishable, because the deparser destroyed the text
      // evidence. Overwriting the second destroys work nothing can restore, so fail
      // closed: propose the adoption but BLOCK it pending `allow.adoptView`.
      //
      // #239: route through the SAME legal/illegal OR-REPLACE decision the managed
      // path makes — a structural change (rename/reorder/mid-insert) is not a legal
      // CREATE OR REPLACE and must be drop+create. `unmanaged: true` carries the
      // adopt-view gate onto whichever change kind we emit.
      if (a.fingerprint === undefined) {
        pushViewUpdate(v, a, changes, /* unmanaged */ true);
        continue;
      }

      // Stamped and equal → converged. THIS is the line that makes `meta migrate` a
      // no-op on an unchanged schema.
      if (a.fingerprint === v.fingerprint) continue;

      // Stamped and different → the view genuinely changed. Prefer a non-destructive
      // CREATE OR REPLACE; fall back to drop+create only when Postgres would refuse it.
      pushViewUpdate(v, a, changes);
      continue;
    }

    // SQLite/D1 (and unknown dialects): verbatim body comparison.
    if (v.sql !== undefined && a.sql !== undefined && !viewSqlEquals(v.sql, a.sql)) {
      changes.push({
        kind: "replace-view", view: v, ...schemaSpread(v.schema), restore: a, status: ALLOWED,
      });
    }
  }

  for (const [id, v] of act) {
    if (!exp.has(id)) {
      changes.push({
        kind: "drop-view", view: v.name, ...schemaSpread(v.schema), restore: v, status: ALLOWED,
      });
    }
  }
}

/**
 * Emit either a non-destructive replace, or the drop+create pair Postgres forces.
 *
 * Replace is strictly better when it is legal: dependent views, grants, and the
 * object's OID all survive. And it IS legal for the common case by construction — a
 * view's columns come out in projection DECLARATION order, so a field APPENDED to a
 * projection lands last, which is exactly what Postgres's prefix rule permits.
 */
function pushViewUpdate(
  expected: ViewDescriptor, actual: ViewDescriptor, changes: Change[],
  // #239: when the ACTUAL view is unmanaged (no fingerprint), this is an ADOPTION —
  // stamp the adopt-view gate (`unmanagedActual`) onto whichever change we emit so
  // status.ts fails closed on `allow.adoptView`, legal-replace and drop+create alike.
  unmanaged = false,
): void {
  const sx = schemaSpread(expected.schema);
  const adopt = unmanaged ? { unmanagedActual: true as const } : {};
  // #239/#240: emit a replace only when it is a legal CREATE OR REPLACE. The decision
  // keys on the EXPECTED (desired) view's column knowledge, NOT on both sides:
  //   - EXPECTED columns KNOWN (a projection): run viewReplaceIsLegal. It fails safe to
  //     `false` (→ drop+create) when the ACTUAL columns are unknown too — which is
  //     exactly the OFFLINE adopt case (#240): a pre-fingerprint snapshot records no
  //     view columns, yet the projection's desired shape IS known, so a structural
  //     change must still drop+create, never an illegal OR REPLACE. (Also fails safe
  //     when actual is known but non-prefix — the #239 online case.)
  //   - EXPECTED columns UNKNOWN (an opaque `@sql` body): legality is unprovable. A
  //     MANAGED change drops+creates (a real body change is safest rebuilt); an ADOPTION
  //     keeps the non-destructive replace (the common "re-stamp an identical,
  //     pre-fingerprint hand-written view" case, #208 — its behavior before #239).
  const legal =
    expected.columns !== undefined
      ? viewReplaceIsLegal(expected.columns, actual.columns)
      : unmanaged;
  if (legal) {
    changes.push({ kind: "replace-view", view: expected, ...sx, restore: actual, ...adopt, status: ALLOWED });
    return;
  }
  // The column list changed shape (removed / renamed / reordered / retyped), so
  // Postgres refuses OR REPLACE. The view must be dropped and rebuilt — which is
  // destructive to anything depending on it (annotateViewDropDependents makes that loud).
  changes.push({ kind: "drop-view", view: expected.name, ...sx, restore: actual, ...adopt, status: ALLOWED });
  changes.push({ kind: "create-view", view: expected, ...sx, status: ALLOWED });
}

/**
 * Attach, to every planned `drop-view`, the relations a CASCADE would destroy.
 *
 * Only EXTERNAL dependents count. A managed view that this same migration drops and
 * recreates is not a loss — it comes back. Everything else is: an unmanaged view, a
 * materialized view, or a managed view not part of this migration. Those belong to
 * someone else, a CASCADE destroys them irrecoverably, and this tool cannot restore
 * what it does not manage.
 *
 * Dependencies are transitive: dropping A cascades to B which cascades to C.
 */
function annotateViewDropDependents(actual: readonly ViewDescriptor[], changes: Change[]): void {
  const byId = new Map(actual.map((v) => [viewIdentity(v), v] as const));
  // Views this migration drops AND recreates — they survive the migration, so a
  // dependent that is one of them is not destroyed.
  const recreated = new Set(
    changes
      .filter((c): c is Extract<Change, { kind: "create-view" }> => c.kind === "create-view")
      .map((c) => viewIdentity(c.view)),
  );

  for (const c of changes) {
    if (c.kind !== "drop-view") continue;
    const dropped = viewIdentity({ name: c.view, ...(c.schema !== undefined ? { schema: c.schema } : {}) });

    // Transitive closure over the dependency edges introspection gave us.
    const seen = new Set<string>([dropped]);
    const queue = [dropped];
    const external: DependentRelation[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const dep of byId.get(cur)?.dependents ?? []) {
        const depId = viewIdentity(dep);
        if (seen.has(depId)) continue;
        seen.add(depId);
        queue.push(depId);
        if (dep.managed && recreated.has(depId)) continue;   // comes back — not a loss
        external.push(dep);
      }
    }
    if (external.length > 0) c.dependents = external;
  }
}

/**
 * Postgres: a view reading a column blocks `ALTER … ALTER COLUMN`, so a column-altering
 * change forces the view to be dropped-before / recreated-after. FK/CHECK changes are
 * `ALTER TABLE ADD/DROP CONSTRAINT` — no table rebuild — so a dependent view is unaffected.
 */
const VIEW_RECREATE_TRIGGERS_PG = new Set<Change["kind"]>([
  "change-column-type", "change-column-nullable", "change-column-default",
  "drop-column", "rename-column",
]);
/**
 * SQLite / D1: recreate-and-copy DROPs + RENAMEs the whole table for ANY of these
 * (RECREATE_TRIGGERING_KINDS), which strands a dependent view across the rebuild even
 * when the columns the view reads are unchanged — an evolved `field.enum @values`, a
 * CHECK, or an FK change. So the FK/CHECK kinds join the column-altering set here. (#243)
 */
const VIEW_RECREATE_TRIGGERS_SQLITE = new Set<Change["kind"]>([
  ...VIEW_RECREATE_TRIGGERS_PG,
  "add-fk", "drop-fk", "add-check", "drop-check",
]);

function recreateViewsDependingOnChangedTables(
  expectedViews: ViewDescriptor[],
  actualViews: ViewDescriptor[],
  changes: Change[],
  dialect: Dialect | undefined,
): void {
  // Only the recreate-and-copy dialects rebuild the table (and strand the view) for an
  // FK/CHECK change; postgres and the dialect-less legacy path keep the narrow set.
  const triggers = dialect === "sqlite" || dialect === "d1"
    ? VIEW_RECREATE_TRIGGERS_SQLITE
    : VIEW_RECREATE_TRIGGERS_PG;
  const actualById = new Map(actualViews.map((v) => [viewIdentity(v), v] as const));
  const alteredTables = new Set<string>();
  for (const c of changes) {
    if (triggers.has(c.kind)) {
      const t = (c as { table?: string }).table;
      if (typeof t === "string") alteredTables.add(t);
    }
  }
  if (alteredTables.size === 0) return;

  for (const v of expectedViews) {
    if (!(v.dependsOn ?? []).some((t) => alteredTables.has(t))) continue;
    const id = viewIdentity(v);

    // Brand-new view (create-view already queued): the DB has no prior view to
    // block the ALTER, and the queued create-view already builds it post-change.
    if (changes.some((c) => c.kind === "create-view" && viewIdentity(c.view) === id)) continue;

    // Supersede any replace-view (CREATE OR REPLACE can't run mid-ALTER) with an
    // explicit drop(before)/create(after) pair — the emit STAGE_ORDER sequences
    // drop-view ahead of the column change and create-view after it.
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i]!;
      if (c.kind === "replace-view" && viewIdentity(c.view) === id) changes.splice(i, 1);
    }
    const prior = actualById.get(id);
    changes.push({
      kind: "drop-view", view: v.name, ...schemaSpread(v.schema),
      ...(prior !== undefined ? { restore: prior } : {}),
      status: ALLOWED,
    });
    changes.push({ kind: "create-view", view: v, ...schemaSpread(v.schema), status: ALLOWED });
  }
}

function columnDefaultsEqual(a: ColumnDescriptor["default"], b: ColumnDescriptor["default"]): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.kind === b.kind && a.value === b.value;
}

function indexEquals(a: IndexDescriptor, b: IndexDescriptor): boolean {
  if (a.unique !== b.unique) return false;
  // Access method: absent = "btree" (the default).
  if ((a.using ?? "btree") !== (b.using ?? "btree")) return false;
  // Expression-key index: compare the normalized key expression (same canonicalizer
  // as predicates). Both-absent = plain index; one-absent = different.
  if ((a.expr === undefined) !== (b.expr === undefined)) return false;
  if (a.expr !== undefined && b.expr !== undefined) {
    if (normalizeCheckExpr(a.expr) !== normalizeCheckExpr(b.expr)) return false;
  }
  if (a.columns.length !== b.columns.length) return false;
  if (!a.columns.every((c, i) => c === b.columns[i])) return false;
  // Per-column ordering: an absent `orders` means all-ascending, so compare against
  // a normalized array (default "asc") rather than requiring both to be present.
  const orderAt = (ix: IndexDescriptor, i: number): "asc" | "desc" => ix.orders?.[i] ?? "asc";
  if (a.columns.some((_, i) => orderAt(a, i) !== orderAt(b, i))) return false;
  // Partial-index predicate: normalize (reuse the CHECK-expr canonicalizer — same PG
  // rewrites: casts, parens, whitespace) so an authored predicate compares equal to
  // the introspected `pg_get_expr` form. Both-absent = equal; one-absent = different.
  if ((a.where === undefined) !== (b.where === undefined)) return false;
  if (a.where !== undefined && b.where !== undefined) {
    if (normalizeCheckExpr(a.where) !== normalizeCheckExpr(b.where)) return false;
  }
  return true;
}

function fkEquals(a: FkDescriptor, b: FkDescriptor): boolean {
  if (a.refTable !== b.refTable) return false;
  if (a.onDelete !== b.onDelete || a.onUpdate !== b.onUpdate) return false;
  if (a.columns.length !== b.columns.length || a.refColumns.length !== b.refColumns.length) return false;
  return a.columns.every((c, i) => c === b.columns[i])
      && a.refColumns.every((c, i) => c === b.refColumns[i]);
}
