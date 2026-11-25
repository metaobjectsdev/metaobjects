// The ROWS layer of the model-only `agent/schema.md`: the tables and views the page describes,
// in the shape the expected schema already has, with every dialect fact left out.
//
// WHY A ROWS LAYER (1.3.0 D0a). The pages are builder → pinned page data → shared template
// (ruling 2a). Page data is finished Markdown cells, which is right for the template and wrong
// for anything else that wants the same facts: the docs site's storage lens draws the same
// tables as HTML and an ERD. So the corpus pins one layer BELOW the page data too, and that
// layer is a literal subset of what `meta schema --as json` prints (the `serializeSnapshot`
// format), not a second shape. A port without the expected schema builds these rows from the
// model with its own naming helpers; TypeScript projects them from the expected schema; the
// docs site reads the same fields from `meta schema`. One shape, three readers.
//
// What is left out is exactly what the model cannot know: SQL types and defaults, indexes,
// checks, foreign-key constraint names and referential actions (design call 17).

import type { AgentSchemaInput, SchemaColumnLike, SchemaTableLike } from "./agent-schema-input.js";

/** One column: the snapshot's own field names, the model-derivable ones only. */
export interface SchemaRowColumn {
  readonly name: string;
  readonly nullable: boolean;
  readonly identity?: "increment" | "uuid";
  readonly description?: string;
}

/** One foreign key, without its constraint name or referential actions. */
export interface SchemaRowForeignKey {
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
}

export interface SchemaRowTable {
  readonly name: string;
  readonly schema?: string;
  readonly description?: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly SchemaRowColumn[];
  readonly foreignKeys: readonly SchemaRowForeignKey[];
}

export interface SchemaRowView {
  readonly name: string;
  readonly schema?: string;
}

/** What a port's model-only schema builder produces before it lays out a single cell. */
export interface SchemaRows {
  /** Tables and views sorted by name, as the snapshot file sorts them; a table's columns and
   *  foreign keys in declaration order, as the page lists them. */
  readonly tables: readonly SchemaRowTable[];
  readonly views: readonly SchemaRowView[];
  /** `<schema>.<name>` (or `<name>` with no schema) → the declaring object's FQN. */
  readonly declaredBy: Readonly<Record<string, string>>;
}

const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The key `declaredBy` uses: what a page heading prints, without the backticks. */
export function schemaRowKey(obj: { readonly name: string; readonly schema?: string | undefined }): string {
  return obj.schema === undefined ? obj.name : `${obj.schema}.${obj.name}`;
}

function columnRow(c: SchemaColumnLike): SchemaRowColumn {
  return {
    name: c.name,
    nullable: c.nullable,
    ...(c.identity !== undefined && { identity: c.identity }),
    ...(c.description !== undefined && c.description !== "" && { description: c.description }),
  };
}

function tableRow(t: SchemaTableLike): SchemaRowTable {
  return {
    name: t.name,
    ...(t.schema !== undefined && { schema: t.schema }),
    ...(t.description !== undefined && t.description !== "" && { description: t.description }),
    primaryKey: [...t.primaryKey],
    // Declaration order, as the expected schema holds it: the page lists columns in it.
    columns: t.columns.map(columnRow),
    foreignKeys: t.foreignKeys.map((fk) => ({ columns: [...fk.columns], refTable: fk.refTable, refColumns: [...fk.refColumns] })),
  };
}

/** Project the expected schema onto the rows a model-only page is built from. */
export function schemaRows(input: AgentSchemaInput): SchemaRows {
  const declaredBy: Record<string, string> = {};
  const note = (obj: { name: string; schema?: string | undefined }): void => {
    const fqn = input.provenance.get(input.qualify(obj));
    if (fqn !== undefined) declaredBy[schemaRowKey(obj)] = fqn;
  };
  const tables = [...input.tables].sort(byName);
  const views = [...input.views].sort(byName);
  for (const t of tables) note(t);
  for (const v of views) note(v);
  return {
    tables: tables.map(tableRow),
    views: views.map((v) => ({ name: v.name, ...(v.schema !== undefined && { schema: v.schema }) })),
    declaredBy: Object.fromEntries(Object.keys(declaredBy).sort().map((k) => [k, declaredBy[k] as string])),
  };
}

/**
 * The page builder's input rebuilt from rows alone: what a port without the expected schema
 * hands `agentSchemaPageData` with `physical: false`. It carries no dialect, no index, no
 * check and no constraint name, and asking it for a SQL type throws, so a model-only page that
 * reached for a dialect fact fails loudly instead of printing one. `migrate` is a project fact,
 * not a row: whether the project chose a `meta migrate` dialect (`migrate.dialect` in
 * `.metaobjects/config.json`).
 */
export function schemaInputFromRows(rows: SchemaRows, migrate: boolean): AgentSchemaInput {
  return {
    dialect: "",
    migrate,
    tables: rows.tables.map((t) => ({
      ...t,
      columns: t.columns.map((c) => ({ ...c })),
      indexes: [],
      checks: [],
      foreignKeys: t.foreignKeys.map((fk) => ({ ...fk, name: "" })),
    })),
    views: rows.views.map((v) => ({ ...v })),
    provenance: new Map(Object.entries(rows.declaredBy)),
    qualify: schemaRowKey,
    columnType: () => {
      throw new Error("a model-only schema page has no SQL type to print");
    },
  };
}
