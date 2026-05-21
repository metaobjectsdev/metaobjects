import type {
  Change, EmitResult, ColumnDescriptor, IndexDescriptor, FkDescriptor,
  TableDescriptor, ColumnDefault, FkAction,
} from "../types.js";
import type { SqlType } from "../sql-type.js";

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
  return {
    up: upStmts.join("\n\n"),
    down: [...downStmts].reverse().join("\n\n"),
    recreatedTables: new Set(), // postgres alters in place; no recreate-and-copy
  };
}

function renderUp(c: Change): string {
  switch (c.kind) {
    case "create-table":           return renderCreateTable(c.table);
    case "drop-table":             return `DROP TABLE ${quote(c.table)};`;
    case "rename-table":           return `ALTER TABLE ${quote(c.from)} RENAME TO ${quote(c.to)};`;
    case "add-column":             return `ALTER TABLE ${quote(c.table)} ADD COLUMN ${renderColumn(c.column)};`;
    case "drop-column":            return `ALTER TABLE ${quote(c.table)} DROP COLUMN ${quote(c.column)};`;
    case "rename-column":          return `ALTER TABLE ${quote(c.table)} RENAME COLUMN ${quote(c.from)} TO ${quote(c.to)};`;
    case "change-column-type":     return `ALTER TABLE ${quote(c.table)} ALTER COLUMN ${quote(c.column)} TYPE ${pgType(c.to)};`;
    case "change-column-nullable":
      return c.to
        ? `ALTER TABLE ${quote(c.table)} ALTER COLUMN ${quote(c.column)} DROP NOT NULL;`
        : `ALTER TABLE ${quote(c.table)} ALTER COLUMN ${quote(c.column)} SET NOT NULL;`;
    case "change-column-default":
      return c.to !== undefined
        ? `ALTER TABLE ${quote(c.table)} ALTER COLUMN ${quote(c.column)} SET DEFAULT ${renderDefault(c.to)};`
        : `ALTER TABLE ${quote(c.table)} ALTER COLUMN ${quote(c.column)} DROP DEFAULT;`;
    case "add-index":              return renderCreateIndex(c.table, c.index);
    case "drop-index":             return `DROP INDEX ${quote(c.index)};`;
    case "add-fk":                 return renderAddFk(c.table, c.fk);
    case "drop-fk":                return `ALTER TABLE ${quote(c.table)} DROP CONSTRAINT ${quote(c.fk)};`;
    case "create-view":
    case "drop-view":
    case "replace-view":
      // emit() filters these; defensive throw if reached.
      throw new Error(`unexpected view-kind in renderPostgres: ${c.kind}`);
  }
}

function renderDown(c: Change): string {
  switch (c.kind) {
    case "create-table":           return `DROP TABLE ${quote(c.table.name)};`;
    case "drop-table":             return `-- WARNING: down migration cannot restore data\n-- TODO: restore table "${c.table}" structure manually`;
    case "rename-table":           return `ALTER TABLE ${quote(c.to)} RENAME TO ${quote(c.from)};`;
    case "add-column":             return `ALTER TABLE ${quote(c.table)} DROP COLUMN ${quote(c.column.name)};`;
    case "drop-column":            return `-- WARNING: down migration cannot restore data\n-- TODO: re-add dropped column "${c.column}" manually with original type/nullable/default`;
    case "rename-column":          return `ALTER TABLE ${quote(c.table)} RENAME COLUMN ${quote(c.to)} TO ${quote(c.from)};`;
    case "change-column-type":     return `ALTER TABLE ${quote(c.table)} ALTER COLUMN ${quote(c.column)} TYPE ${pgType(c.from)};`;
    case "change-column-nullable":
      return c.from
        ? `ALTER TABLE ${quote(c.table)} ALTER COLUMN ${quote(c.column)} DROP NOT NULL;`
        : `ALTER TABLE ${quote(c.table)} ALTER COLUMN ${quote(c.column)} SET NOT NULL;`;
    case "change-column-default":
      return c.from !== undefined
        ? `ALTER TABLE ${quote(c.table)} ALTER COLUMN ${quote(c.column)} SET DEFAULT ${renderDefault(c.from)};`
        : `ALTER TABLE ${quote(c.table)} ALTER COLUMN ${quote(c.column)} DROP DEFAULT;`;
    case "add-index":              return `DROP INDEX ${quote(c.index.name)};`;
    case "drop-index":             return `-- WARNING: down migration cannot restore the original index definition`;
    case "add-fk":                 return `ALTER TABLE ${quote(c.table)} DROP CONSTRAINT ${quote(c.fk.name)};`;
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
  return `CREATE TABLE ${quote(t.name)} (\n${colDefs.join(",\n")}\n);`;
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

function renderCreateIndex(table: string, ix: IndexDescriptor): string {
  const u = ix.unique ? "UNIQUE " : "";
  return `CREATE ${u}INDEX ${quote(ix.name)} ON ${quote(table)} (${ix.columns.map(quote).join(", ")});`;
}

function renderAddFk(table: string, fk: FkDescriptor): string {
  let s = `ALTER TABLE ${quote(table)} ADD CONSTRAINT ${quote(fk.name)} `;
  s += `FOREIGN KEY (${fk.columns.map(quote).join(", ")}) `;
  s += `REFERENCES ${quote(fk.refTable)} (${fk.refColumns.map(quote).join(", ")})`;
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
