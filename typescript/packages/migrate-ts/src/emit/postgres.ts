import type {
  Change, EmitResult, ColumnDescriptor, IndexDescriptor, FkDescriptor,
  TableDescriptor, ColumnDefault, FkAction,
} from "../types.js";
import type { SqlType } from "../sql-type.js";
import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjects/metadata";

const STAGE_ORDER: Record<Change["kind"], number> = {
  "create-table": 1,
  "add-column": 2, "drop-column": 2,
  "change-column-type": 2, "change-column-nullable": 2, "change-column-default": 2,
  "rename-column": 3, "rename-table": 3,
  "add-index": 4, "drop-index": 4,
  "add-fk": 5, "drop-fk": 5,
  "drop-table": 6,
  // view kinds — never reach here (filtered in emit())
  "create-view": 99, "drop-view": 99, "replace-view": 99,
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
  return { up: upStmts.join("\n\n"), down: [...downStmts].reverse().join("\n\n") };
}

function renderUp(c: Change): string {
  switch (c.kind) {
    case "create-table":           return renderCreateTable(c.table);
    case "drop-table":             return `DROP TABLE ${quoteQualified(c.table, c.schema)};`;
    case "rename-table":           return `ALTER TABLE ${quoteQualified(c.from, c.schema)} RENAME TO ${quote(c.to)};`;
    case "add-column":             return `ALTER TABLE ${quoteQualified(c.table, c.schema)} ADD COLUMN ${renderColumn(c.column)};`;
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
    case "create-view":
    case "drop-view":
    case "replace-view":
      // emit() filters these; defensive throw if reached.
      throw new Error(`unexpected view-kind in renderPostgres: ${c.kind}`);
  }
}

function renderDown(c: Change): string {
  switch (c.kind) {
    case "create-table":           return `DROP TABLE ${quoteQualified(c.table.name, c.table.schema)};`;
    case "drop-table":             return `-- WARNING: down migration cannot restore data\n-- TODO: restore table "${c.table}" structure manually`;
    case "rename-table":           return `ALTER TABLE ${quoteQualified(c.to, c.schema)} RENAME TO ${quote(c.from)};`;
    case "add-column":             return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP COLUMN ${quote(c.column.name)};`;
    case "drop-column":            return `-- WARNING: down migration cannot restore data\n-- TODO: re-add dropped column "${c.column}" manually with original type/nullable/default`;
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
    case "drop-index":             return `-- WARNING: down migration cannot restore the original index definition`;
    case "add-fk":                 return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP CONSTRAINT ${quote(c.fk.name)};`;
    case "drop-fk":                return `-- WARNING: down migration cannot restore the original FK definition`;
    case "create-view":
    case "drop-view":
    case "replace-view":
      throw new Error(`unexpected view-kind in renderPostgres: ${c.kind}`);
  }
}

function renderCreateTable(t: TableDescriptor): string {
  const colDefs = t.columns.map((c) => `  ${renderColumn(c)}`);
  if (t.primaryKey.length > 0) {
    colDefs.push(`  CONSTRAINT ${quote(t.name + "_pkey")} PRIMARY KEY (${t.primaryKey.map(quote).join(", ")})`);
  }
  return `CREATE TABLE ${quoteQualified(t.name, t.schema)} (\n${colDefs.join(",\n")}\n);`;
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
    case "numeric":   {
      if (t.precision !== undefined && t.scale !== undefined) return `NUMERIC(${t.precision},${t.scale})`;
      if (t.precision !== undefined) return `NUMERIC(${t.precision})`;
      return "NUMERIC";
    }
    case "boolean":   return "BOOLEAN";
    case "timestamp": return t.withTimezone ? "TIMESTAMPTZ" : "TIMESTAMP";
    case "date":      return "DATE";
    case "json":      return "JSONB";
    case "blob":      return "BYTEA";
    case "uuid":      return "UUID";
  }
}

function renderDefault(d: ColumnDefault): string {
  if (d.kind === "expr") return d.value;
  // Literal: quote string-form values.
  return `'${d.value.replace(/'/g, "''")}'`;
}

function renderCreateIndex(table: string, schema: string | undefined, ix: IndexDescriptor): string {
  const u = ix.unique ? "UNIQUE " : "";
  // Index name itself is unqualified in CREATE INDEX (Postgres places the index
  // in the same schema as the table being indexed). Only the ON clause needs qualification.
  return `CREATE ${u}INDEX ${quote(ix.name)} ON ${quoteQualified(table, schema)} (${ix.columns.map(quote).join(", ")});`;
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
