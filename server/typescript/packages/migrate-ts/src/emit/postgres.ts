import type {
  Change, EmitResult, ColumnDescriptor, IndexDescriptor, FkDescriptor,
  TableDescriptor, ViewDescriptor, ColumnDefault, FkAction,
} from "../types.js";
import type { SqlType } from "../sql-type.js";
import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjectsdev/metadata";
import { renderFingerprintMarker, viewFingerprint } from "../view-fingerprint.js";
import { viewReplaceIsLegal } from "../view-column-types.js";

// Stages run low → high. drop-view runs BEFORE drop-table so a view that
// depends on a soon-to-be-dropped table is removed first. create-view runs
// AFTER add-fk so the view can reference the new schema in full.
//
// #255: a constraint/index DROP and its ADD counterpart share the same kind
// but need OPPOSITE ordering relative to column mutation — a drop must run
// BEFORE the column change (the constraint/index must be gone before its
// column is dropped, or Postgres refuses `DROP COLUMN` with "other objects
// depend on it" — this applies just as much to an index backing a UNIQUE/FK
// target as it does to the FK/CHECK constraint itself), while an add must run
// AFTER (the column it references must already exist). One stage can't
// satisfy both, so ALL drops — drop-fk/drop-check/drop-index — are hoisted
// ahead of any column mutation; their ADD counterparts (add-fk/add-check/
// add-index) stay at their later stages.
//
// Within that "drops" group, drop-fk/drop-check must ALSO run BEFORE
// drop-index: an FK constraint depends on the unique/PK index backing its
// target column (that's how Postgres enforces the target must be unique), so
// dropping the index first fails with the same "other objects depend on it"
// class of error, one level removed — "constraint … depends on index …".
// drop-index therefore gets its own stage (1.5) strictly between drop-fk/
// drop-check/create-table (1) and column mutation (2).
const STAGE_ORDER: Record<Change["kind"], number> = {
  "drop-view": 0,
  "drop-fk": 1, "drop-check": 1,
  "create-table": 1,
  "drop-index": 1.5,
  "add-column": 2, "drop-column": 2,
  "change-column-type": 2, "change-column-nullable": 2, "change-column-default": 2,
  "rename-column": 3, "rename-table": 3,
  "add-index": 4,
  "add-fk": 5,
  "add-check": 5,
  "drop-table": 6,
  "create-view": 7, "replace-view": 7,
};

export function renderPostgres(changes: Change[]): EmitResult {
  const sorted = [...changes].sort((a, b) => STAGE_ORDER[a.kind] - STAGE_ORDER[b.kind]);
  const upStmts: string[] = [];
  const downStmts: string[] = [];
  for (const c of sorted) {
    upStmts.push(renderUp(c));
    downStmts.push(renderDown(c));
  }
  // Down runs in reverse order (so creates undo correctly w.r.t. FKs).
  return {
    up: upStmts.join("\n\n"),
    down: [...downStmts].reverse().join("\n\n"),
    recreatedTables: new Set(), // postgres alters in place; no recreate-and-copy
  };
}

function renderUp(c: Change): string {
  switch (c.kind) {
    case "create-table":           return renderCreateTable(c.table);
    case "drop-table":             return `DROP TABLE ${quoteQualified(c.table, c.schema)};`;
    case "rename-table":           return `ALTER TABLE ${quoteQualified(c.from, c.schema)} RENAME TO ${quote(c.to)};`;
    case "add-column": {
      const base = `ALTER TABLE ${quoteQualified(c.table, c.schema)} ADD COLUMN ${renderColumn(c.column)};`;
      if (!c.column.description) return base;
      return `${base}\n${columnCommentSql(c.table, c.schema, c.column.name, c.column.description)}`;
    }
    case "drop-column":            return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP COLUMN ${quote(c.column)};`;
    case "rename-column":          return `ALTER TABLE ${quoteQualified(c.table, c.schema)} RENAME COLUMN ${quote(c.from)} TO ${quote(c.to)};`;
    case "change-column-type":     return `ALTER TABLE ${quoteQualified(c.table, c.schema)} ALTER COLUMN ${quote(c.column)} TYPE ${pgType(c.to)};`;
    case "change-column-nullable":
      return c.to
        ? `ALTER TABLE ${quoteQualified(c.table, c.schema)} ALTER COLUMN ${quote(c.column)} DROP NOT NULL;`
        : `ALTER TABLE ${quoteQualified(c.table, c.schema)} ALTER COLUMN ${quote(c.column)} SET NOT NULL;`;
    case "change-column-default":
      return c.to !== undefined
        ? `ALTER TABLE ${quoteQualified(c.table, c.schema)} ALTER COLUMN ${quote(c.column)} SET DEFAULT ${renderDefault(c.to)};`
        : `ALTER TABLE ${quoteQualified(c.table, c.schema)} ALTER COLUMN ${quote(c.column)} DROP DEFAULT;`;
    case "add-index":              return renderCreateIndex(c.table, c.schema, c.index);
    case "drop-index":             return `DROP INDEX ${quoteIndexQualified(c.index, c.schema)};`;
    case "add-fk":                 return renderAddFk(c.table, c.schema, c.fk);
    case "drop-fk":                return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP CONSTRAINT ${quote(c.fk)};`;
    // add-check / drop-check are declared but NOT yet produced by the diff —
    // checks are create-time-only (inlined in CREATE TABLE via renderCreateTable).
    // These arms exist for future existing-table CHECK evolution support, mirroring
    // the create-view/drop-view "declared, not yet produced" pattern.
    case "add-check":              return `ALTER TABLE ${quoteQualified(c.table, c.schema)} ADD CONSTRAINT ${quote(c.check.name)} CHECK (${c.check.expression});`;
    case "drop-check":             return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP CONSTRAINT ${quote(c.check)};`;
    case "create-view":            return renderCreateView(c.view, c.schema, /* orReplace */ false);
    case "drop-view":              return renderDropView(c);
    case "replace-view":           return renderCreateView(c.view, c.schema, /* orReplace */ true);
  }
}

function renderDown(c: Change): string {
  switch (c.kind) {
    case "create-table":           return `DROP TABLE ${quoteQualified(c.table.name, c.table.schema)};`;
    case "drop-table": {
      if (!c.restore) {
        return `-- WARNING: down migration cannot restore data\n-- TODO: restore table "${c.table}" structure manually`;
      }
      // renderCreateTable emits only columns + PK + checks. Indexes and FKs ride
      // as separate add-index/add-fk changes on the up side, so re-create them
      // explicitly here or the down silently loses them.
      const parts = [renderCreateTable(c.restore)];
      for (const index of c.restore.indexes) {
        parts.push(renderCreateIndex(c.restore.name, c.restore.schema, index));
      }
      for (const fk of c.restore.foreignKeys) {
        parts.push(renderAddFk(c.restore.name, c.restore.schema, fk));
      }
      parts.push("-- NOTE: table data is not restored by this down migration.");
      return parts.join("\n");
    }
    case "rename-table":           return `ALTER TABLE ${quoteQualified(c.to, c.schema)} RENAME TO ${quote(c.from)};`;
    case "add-column":             return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP COLUMN ${quote(c.column.name)};`;
    case "drop-column":
      return c.restore
        ? `ALTER TABLE ${quoteQualified(c.table, c.schema)} ADD COLUMN ${renderColumn(c.restore)};\n-- NOTE: column data is not restored by this down migration.`
        : `-- WARNING: down migration cannot restore data\n-- TODO: re-add dropped column "${c.column}" manually with original type/nullable/default`;
    case "rename-column":          return `ALTER TABLE ${quoteQualified(c.table, c.schema)} RENAME COLUMN ${quote(c.to)} TO ${quote(c.from)};`;
    case "change-column-type":     return `ALTER TABLE ${quoteQualified(c.table, c.schema)} ALTER COLUMN ${quote(c.column)} TYPE ${pgType(c.from)};`;
    case "change-column-nullable":
      return c.from
        ? `ALTER TABLE ${quoteQualified(c.table, c.schema)} ALTER COLUMN ${quote(c.column)} DROP NOT NULL;`
        : `ALTER TABLE ${quoteQualified(c.table, c.schema)} ALTER COLUMN ${quote(c.column)} SET NOT NULL;`;
    case "change-column-default":
      return c.from !== undefined
        ? `ALTER TABLE ${quoteQualified(c.table, c.schema)} ALTER COLUMN ${quote(c.column)} SET DEFAULT ${renderDefault(c.from)};`
        : `ALTER TABLE ${quoteQualified(c.table, c.schema)} ALTER COLUMN ${quote(c.column)} DROP DEFAULT;`;
    case "add-index":              return `DROP INDEX ${quoteIndexQualified(c.index.name, c.schema)};`;
    case "drop-index":
      return c.restore
        ? renderCreateIndex(c.table, c.schema, c.restore)
        : `-- WARNING: down migration cannot restore the original index definition`;
    case "add-fk":                 return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP CONSTRAINT ${quote(c.fk.name)};`;
    case "drop-fk":
      return c.restore
        ? renderAddFk(c.table, c.schema, c.restore)
        : `-- WARNING: down migration cannot restore the original FK definition`;
    // add-check / drop-check down arms: declared but not yet produced by the diff
    // (checks are create-time-only; see renderUp note).
    case "add-check":              return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP CONSTRAINT ${quote(c.check.name)};`;
    case "drop-check":
      return c.restore
        ? `ALTER TABLE ${quoteQualified(c.table, c.schema)} ADD CONSTRAINT ${quote(c.restore.name)} CHECK (${c.restore.expression});`
        : `-- WARNING: down migration cannot restore the original CHECK definition`;
    case "create-view":            return `DROP VIEW ${quoteQualifiedView(c.view.name, c.schema)};`;
    // The deparsed body introspection captured IS a valid restore payload.
    case "drop-view":              return renderRestoreView(c.restore, c.view, c.schema);
    case "replace-view":           return renderRestoreView(c.restore, c.view.name, c.schema, c.view);
  }
}

function renderCreateTable(t: TableDescriptor): string {
  const colDefs = t.columns.map((c) => `  ${renderColumn(c)}`);
  if (t.primaryKey.length > 0) {
    colDefs.push(`  CONSTRAINT ${quote(t.name + "_pkey")} PRIMARY KEY (${t.primaryKey.map(quote).join(", ")})`);
  }
  for (const chk of t.checks ?? []) {
    colDefs.push(`  CONSTRAINT ${quote(chk.name)} CHECK (${chk.expression})`);
  }
  const create = `CREATE TABLE ${quoteQualified(t.name, t.schema)} (\n${colDefs.join(",\n")}\n);`;
  const comments = renderTableComments(t);
  return comments.length === 0 ? create : `${create}\n${comments.join("\n")}`;
}

function renderTableComments(t: TableDescriptor): string[] {
  const out: string[] = [];
  if (t.description) {
    out.push(`COMMENT ON TABLE ${quoteQualified(t.name, t.schema)} IS '${pgEscape(t.description)}';`);
  }
  for (const col of t.columns) {
    if (col.description) {
      out.push(columnCommentSql(t.name, t.schema, col.name, col.description));
    }
  }
  return out;
}

function columnCommentSql(
  table: string,
  schema: string | undefined,
  column: string,
  description: string,
): string {
  return `COMMENT ON COLUMN ${quoteQualified(table, schema)}.${quote(column)} IS '${pgEscape(description)}';`;
}

function pgEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function renderColumn(c: ColumnDescriptor): string {
  let s = `${quote(c.name)} ${pgType(c.sqlType)}`;
  if (c.identity === "increment") s += " GENERATED BY DEFAULT AS IDENTITY";
  if (c.identity === "uuid")      s += " DEFAULT gen_random_uuid()";
  s += c.nullable ? "" : " NOT NULL";
  if (c.default !== undefined && c.identity !== "uuid") {
    // For uuid identity we already set DEFAULT gen_random_uuid(); don't duplicate.
    s += ` DEFAULT ${renderDefault(c.default)}`;
  }
  return s;
}

function pgType(t: SqlType): string {
  switch (t.kind) {
    case "text":      return t.maxLength !== undefined ? `VARCHAR(${t.maxLength})` : "TEXT";
    case "integer":   return t.bits === 64 ? "BIGINT" : "INTEGER";
    case "real":      return "DOUBLE PRECISION";
    case "real4":     return "REAL";
    case "numeric":   {
      if (t.precision !== undefined && t.scale !== undefined) return `NUMERIC(${t.precision},${t.scale})`;
      if (t.precision !== undefined) return `NUMERIC(${t.precision})`;
      return "NUMERIC";
    }
    case "boolean":   return "BOOLEAN";
    case "timestamp": return t.withTimezone ? "TIMESTAMPTZ" : "TIMESTAMP";
    case "date":      return "DATE";
    case "time":      return "TIME";
    case "json":      return "JSONB";
    case "blob":      return "BYTEA";
    case "uuid":      return "UUID";
    case "inet":      return "INET";
    case "array":     return `${pgType(t.element)}[]`;
  }
}

function renderDefault(d: ColumnDefault): string {
  if (d.kind === "expr") return d.value;
  // Literal: quote string-form values.
  return `'${pgEscape(d.value)}'`;
}

function renderCreateIndex(table: string, schema: string | undefined, ix: IndexDescriptor): string {
  const u = ix.unique ? "UNIQUE " : "";
  // Key list: a raw expression (functional/expression index) takes precedence over
  // the per-column list. The expression is emitted verbatim (already valid SQL).
  const keys = ix.expr
    ? ix.expr
    : ix.columns
        .map((c, i) => (ix.orders?.[i] === "desc" ? `${quote(c)} DESC` : quote(c)))
        .join(", ");
  // Access method: btree is the default and intentionally not rendered (matches PG's
  // canonical def); anything else (gin/gist/hash/…) is emitted as `USING <method>`.
  const using = ix.using && ix.using !== "btree" ? ` USING ${ix.using}` : "";
  // Partial-index predicate, when present.
  const where = ix.where ? ` WHERE (${ix.where})` : "";
  // Index name itself is unqualified in CREATE INDEX (Postgres places the index
  // in the same schema as the table being indexed). Only the ON clause needs qualification.
  return `CREATE ${u}INDEX ${quote(ix.name)} ON ${quoteQualified(table, schema)}${using} (${keys})${where};`;
}

function renderAddFk(table: string, schema: string | undefined, fk: FkDescriptor): string {
  let s = `ALTER TABLE ${quoteQualified(table, schema)} ADD CONSTRAINT ${quote(fk.name)} `;
  s += `FOREIGN KEY (${fk.columns.map(quote).join(", ")}) `;
  // v1 limitation: FkDescriptor does not carry the ref-table's schema today.
  // Assume the referenced table lives in the same schema as the FK-owner.
  // For cross-schema FKs, add `refSchema?` to FkDescriptor in a follow-up.
  s += `REFERENCES ${quoteQualified(fk.refTable, schema)} (${fk.refColumns.map(quote).join(", ")})`;
  if (fk.onDelete) s += ` ON DELETE ${fkActionSql(fk.onDelete)}`;
  if (fk.onUpdate) s += ` ON UPDATE ${fkActionSql(fk.onUpdate)}`;
  return s + ";";
}

function fkActionSql(a: FkAction): string {
  switch (a) {
    case "cascade":   return "CASCADE";
    case "set-null":  return "SET NULL";
    case "restrict":  return "RESTRICT";
    case "no-action": return "NO ACTION";
  }
}

function quote(ident: string): string {
  // Conservative double-quoting; reject embedded quotes (defense).
  if (ident.includes('"')) throw new Error(`unsafe identifier: ${ident}`);
  return `"${ident}"`;
}

/**
 * Quote a table identifier, prefixing the schema when non-default. The Postgres
 * default schema is `public`; undefined and "public" both mean "no prefix needed."
 */
function quoteQualified(table: string, schema: string | undefined): string {
  if (!schema || schema === DEFAULT_DB_SCHEMA_POSTGRES) return quote(table);
  return quote(schema) + "." + quote(table);
}

/**
 * Quote an index identifier for DROP INDEX, prefixing the schema when non-default.
 * In Postgres, indexes live in the same schema as their owning table; DROP INDEX
 * accepts the qualified form `"schema"."index"`.
 */
function quoteIndexQualified(index: string, schema: string | undefined): string {
  if (!schema || schema === DEFAULT_DB_SCHEMA_POSTGRES) return quote(index);
  return quote(schema) + "." + quote(index);
}

/** Same shape as quoteQualified, just for view identifiers (kept separate for readability). */
function quoteQualifiedView(view: string, schema: string | undefined): string {
  return quoteQualified(view, schema);
}

/**
 * Emit the view AND stamp it with the fingerprint of the body we just wrote.
 *
 * The stamp is not decoration — it is the ONLY way a later migrate can tell whether
 * this view is up to date. Postgres does not store view SQL (it deparses it from the
 * parse tree), so the text can never be read back and compared; the fingerprint in the
 * view's COMMENT can. Drop the stamp and every migrate re-proposes every view forever.
 *
 * `CREATE OR REPLACE VIEW` does NOT clear an existing comment, so re-stamping on every
 * replace is both required (the body changed → the hash changed) and sufficient.
 */
function renderCreateView(v: ViewDescriptor, schema: string | undefined, orReplace: boolean): string {
  if (v.sql === undefined || v.sql.trim().length === 0) {
    throw new Error(`view "${v.name}" has no sql body — buildExpectedSchema must populate it before emit`);
  }
  const prefix = orReplace ? "CREATE OR REPLACE VIEW" : "CREATE VIEW";
  const qualified = quoteQualifiedView(v.name, schema);
  const create = `${prefix} ${qualified} AS\n${v.sql};`;
  const fingerprint = v.fingerprint ?? viewFingerprint(v.sql);
  return `${create}\n${renderViewComment(qualified, renderFingerprintMarker(fingerprint))}`;
}

function renderViewComment(qualifiedView: string, comment: string | null): string {
  if (comment === null) return `COMMENT ON VIEW ${qualifiedView} IS NULL;`;
  return `COMMENT ON VIEW ${qualifiedView} IS '${comment.replace(/'/g, "''")}';`;
}

/**
 * DROP VIEW, plus — when the drop would cascade into relations we do not manage — a
 * banner naming every one of them.
 *
 * The banner lives in the emitted SQL rather than only in CLI output on purpose: the
 * migration file is committed and code-reviewed, and "this statement destroys three
 * objects belonging to another application" is exactly the thing a reviewer must see.
 *
 * CASCADE is emitted ONLY when explicitly allowed. Otherwise a plain DROP VIEW is
 * emitted even if dependents are known — so if a dependent appeared between introspect
 * and apply, Postgres itself refuses the drop rather than silently destroying it.
 */
function renderDropView(c: Extract<Change, { kind: "drop-view" }>): string {
  const qualified = quoteQualifiedView(c.view, c.schema);
  const dependents = c.dependents ?? [];
  if (dependents.length === 0) return `DROP VIEW ${qualified};`;

  const listed = dependents
    .map((d) => `--   ${d.schema}.${d.name} (${d.relkind === "m" ? "materialized view" : "view"})`)
    .join("\n");
  const rule = "-- " + "=".repeat(74);
  return [
    rule,
    "-- WARNING: CASCADE DROP. The following dependent objects are DESTROYED by this",
    "-- statement. MetaObjects does not manage them and the down migration does NOT",
    "-- restore them:",
    listed,
    rule,
    `DROP VIEW ${qualified} CASCADE;`,
  ].join("\n");
}

/**
 * Restore a view the up migration dropped or replaced.
 *
 * The payload is Postgres's own deparsed body (`pg_get_viewdef`) — useless for
 * COMPARISON, but perfectly valid SQL that reproduces the view. So the thing that made
 * the bug (the deparser) is what makes down migrations restorable. The prior stamp is
 * replayed verbatim: the restored parse tree IS the pre-migration view, so its old
 * fingerprint is still the truthful one.
 */
function renderRestoreView(
  restore: ViewDescriptor | undefined,
  name: string,
  schema: string | undefined,
  /** The view the UP migration left in place — i.e. what the down is replacing. */
  current?: ViewDescriptor,
): string {
  if (restore?.sql === undefined || restore.sql.trim().length === 0) {
    return `-- WARNING: down migration cannot restore the original view definition`;
  }
  const qualified = quoteQualifiedView(name, schema);
  const body = restore.sql.trim().replace(/;\s*$/, "");

  // Postgres's OR-REPLACE prefix rule applies to the down migration too, and usually
  // REFUSES: undoing an appended field means REMOVING a view column, and
  // `CREATE OR REPLACE VIEW` cannot drop columns ("cannot drop columns from view").
  // So ask the same question the forward path asks, with the arguments swapped — and
  // fall back to DROP + CREATE when the answer is no.
  //
  // The fallback DROP is deliberately NOT `CASCADE`: if a dependent has since been built
  // on the newer shape, Postgres refuses the down migration rather than silently
  // destroying that dependent. Loud beats convenient.
  const stamp = restore.fingerprint !== undefined
    ? renderViewComment(qualified, renderFingerprintMarker(restore.fingerprint))
    // The view being restored carried NO fingerprint (hand-written, or pre-stamping).
    // Clear ours — otherwise the restored view would advertise a stamp for a body it
    // does not have, and the next migrate would believe the stamp and skip it.
    : renderViewComment(qualified, null);

  if (current !== undefined && !viewReplaceIsLegal(restore.columns, current.columns)) {
    return `DROP VIEW ${qualified};\nCREATE VIEW ${qualified} AS\n${body};\n${stamp}`;
  }
  return `CREATE OR REPLACE VIEW ${qualified} AS\n${body};\n${stamp}`;
}
