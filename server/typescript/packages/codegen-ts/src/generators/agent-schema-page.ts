// `agent/schema.md` — the physical schema, for an agent about to touch persistence.
//
// WHY THIS PAGE EXISTS AND WHY IT LOOKS LIKE THIS
//
// The strongest measured finding behind this surface is not about format: roughly 2K
// tokens of BUSINESS SEMANTICS beside the schema is worth an order of magnitude more
// than any table-versus-YAML-versus-DDL choice. So every table and column carries its
// `@description`, and the descriptions come from the snapshot itself — `migrate-ts`
// already threads them there to emit `COMMENT ON`, which means the page and the database
// comment cannot disagree.
//
// IT DOES NOT RESTATE THE DDL. The migration files ARE the DDL, they are generated, and
// they are what actually runs. A page that reproduces `CREATE TABLE` is a second spelling
// of the same fact that goes stale the first time someone regenerates without it — so
// this page describes the schema and CITES the migrations for the statements.
//
// It is TABLE-DRIVEN, not entity-driven, and that is deliberate: a TPH hierarchy folds
// several entities into one table, an abstract base has none, and an `@unmanaged` object
// is excluded — all rules `buildExpectedSchema`'s Pass 1 already owns. Walking entities
// here would mean re-implementing those skip rules and drifting from them. The declaring
// object is named per table from the provenance map instead.

import { GENERATED_HEADER } from "../constants.js";
import type {
  AgentSchemaInput,
  SchemaColumnLike,
  SchemaFkLike,
  SchemaIndexLike,
  SchemaTableLike,
} from "./agent-schema-input.js";

const GENERATED_MARKER = `<!-- ${GENERATED_HEADER} — DO NOT EDIT. -->`;

/** Markdown-escape a cell whose text may contain a `|` (a CHECK expression can). */
function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** Collapse a description to one line — a newline inside a table cell ends the row. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `` `a`, `b` `` — a column list, or an em-dash when empty. */
function cols(list: readonly string[]): string {
  return list.length === 0 ? "—" : list.map((c) => `\`${c}\``).join(", ");
}

/**
 * The KEY cell: primary / foreign / unique / indexed, most-specific first.
 *
 * A COMPOSITE index is labelled as one. A bare `unique` on a column that is merely one
 * member of a two-column unique index asserts that the column alone is unique — which is
 * false, and false in the direction that makes a reader write a lookup that returns more
 * than one row. The Indexes section below carries the full key; this cell only has to stop
 * being wrong about it.
 */
function keyCell(table: SchemaTableLike, column: SchemaColumnLike): string {
  const roles: string[] = [];
  if (table.primaryKey.includes(column.name)) {
    roles.push(table.primaryKey.length > 1 ? "PK (composite)" : "PK");
  }
  const fk = table.foreignKeys.find((f) => f.columns.includes(column.name));
  if (fk !== undefined) roles.push(`FK → \`${fk.refTable}\``);
  const covering = table.indexes.filter((i) => i.columns.includes(column.name));
  const unique = covering.find((i) => i.unique);
  const index = unique ?? covering[0];
  if (index !== undefined) {
    const label = unique !== undefined ? "unique" : "indexed";
    roles.push(index.columns.length > 1 ? `${label} (composite)` : label);
  }
  return roles.length === 0 ? "" : roles.join(" · ");
}

/** The DEFAULT cell. An `expr` default is shown as SQL; a literal as a literal. */
function defaultCell(column: SchemaColumnLike): string {
  if (column.identity === "increment") return "auto-increment";
  if (column.identity === "uuid") return "generated uuid";
  if (column.default === undefined) return "";
  return `\`${mdCell(column.default.value)}\``;
}

function indexLine(ix: SchemaIndexLike): string {
  const key = ix.expr !== undefined ? `\`${mdCell(ix.expr)}\`` : cols(ix.columns);
  const parts = [`\`${ix.name}\``, ix.unique ? "unique" : "index", `on ${key}`];
  if (ix.using !== undefined && ix.using !== "" && ix.using !== "btree") parts.push(`using \`${ix.using}\``);
  if (ix.where !== undefined && ix.where !== "") parts.push(`where \`${mdCell(ix.where)}\``);
  return `- ${parts.join(" · ")}`;
}

function fkLine(fk: SchemaFkLike): string {
  const parts = [
    `\`${fk.name}\``,
    `${cols(fk.columns)} → \`${fk.refTable}\`(${cols(fk.refColumns)})`,
  ];
  if (fk.onDelete !== undefined && fk.onDelete !== "") parts.push(`on delete \`${fk.onDelete}\``);
  if (fk.onUpdate !== undefined && fk.onUpdate !== "") parts.push(`on update \`${fk.onUpdate}\``);
  return `- ${parts.join(" · ")}`;
}

/**
 * One table's section: the declaring object, its description, the column table, then
 * whichever of indexes / foreign keys / checks the table actually has.
 *
 * `declaredBy` maps a physical column name back to the FIELD that declared it — the
 * mapping an agent needs to go from a query it is reading to the metadata it must edit,
 * and the one thing the snapshot alone cannot supply.
 */
function tableSection(
  table: SchemaTableLike,
  input: AgentSchemaInput,
  fqn: string | undefined,
  declaredBy: ReadonlyMap<string, { field: string; type: string }>,
): string[] {
  const out: string[] = [];
  const qualified = table.schema === undefined ? `\`${table.name}\`` : `\`${table.schema}.${table.name}\``;
  out.push(`### ${qualified}`);
  out.push("");
  if (fqn !== undefined) out.push(`Declared by \`${fqn}\`.`);
  if (table.description !== undefined && table.description !== "") {
    out.push("");
    out.push(`> ${oneLine(table.description)}`);
  }
  out.push("");
  out.push("| Column | Field | Declared | SQL type | Null | Default | Key |");
  out.push("|---|---|---|---|---|---|---|");
  for (const c of table.columns) {
    const declared = declaredBy.get(c.name);
    out.push(
      `| \`${c.name}\` | ${declared === undefined ? "" : `\`${declared.field}\``} | ` +
        `${declared === undefined ? "" : `\`${declared.type}\``} | \`${mdCell(input.columnType(c))}\` | ` +
        `${c.nullable ? "yes" : "no"} | ${defaultCell(c)} | ${keyCell(table, c)} |`,
    );
  }
  // Column descriptions ride BELOW the table rather than as an eighth cell: a sentence
  // in a cell forces the whole table wide, and most columns have none.
  const described = table.columns.filter((c) => c.description !== undefined && c.description !== "");
  if (described.length > 0) {
    out.push("");
    for (const c of described) out.push(`- \`${c.name}\` — ${oneLine(c.description ?? "")}`);
  }
  if (table.indexes.length > 0) {
    out.push("");
    out.push("**Indexes**");
    out.push("");
    for (const ix of table.indexes) out.push(indexLine(ix));
  }
  if (table.foreignKeys.length > 0) {
    out.push("");
    out.push("**Foreign keys**");
    out.push("");
    for (const fk of table.foreignKeys) out.push(fkLine(fk));
  }
  if (table.checks.length > 0) {
    out.push("");
    out.push("**Checks**");
    out.push("");
    for (const ck of table.checks) out.push(`- \`${ck.name}\` — \`${mdCell(ck.expression)}\``);
  }
  out.push("");
  return out;
}

export interface AgentSchemaPageOptions {
  /** Column → declaring field, per QUALIFIED table name. Supplied by the generator, which
   *  holds the loaded model; see `agentDocsFile`. */
  readonly declaredBy: ReadonlyMap<string, ReadonlyMap<string, { field: string; type: string }>>;
  /** Per-projection lineage lines, keyed by QUALIFIED view name. */
  readonly viewLineage: ReadonlyMap<string, readonly string[]>;
  /** Relationship lines, already rendered from the model. */
  readonly relationships: readonly string[];
  /** Enum lines, already rendered from the model. */
  readonly enums: readonly string[];
}

/**
 * Render the whole page. Returns "" when there is no physical schema at all, which is
 * what lets the surface emit no FILE rather than a page describing nothing.
 */
export function renderAgentSchemaPage(
  input: AgentSchemaInput,
  opts: AgentSchemaPageOptions,
): string {
  if (input.tables.length === 0 && input.views.length === 0) return "";

  const out: string[] = [];
  out.push(GENERATED_MARKER);
  out.push("");
  out.push("# Schema");
  out.push("");
  out.push(
    `The physical shape of the \`${input.dialect}\` database this model generates. ` +
      "Read it before writing a query, a migration, or anything that names a table or a column.",
  );
  out.push("");
  out.push(
    "- The **DDL is not repeated here.** The migration files are the DDL, they are " +
      "generated, and they are what runs — this page describes the schema they produce.",
  );
  out.push(
    "- Change the schema by changing the **metadata** and running `meta migrate`. Never " +
      "hand-apply SQL to a live database: it drifts from the migration history and " +
      "collides at the next migrate.",
  );
  out.push(
    "- `Field` and `Declared` are the METADATA names. Edit those; the column name follows.",
  );
  out.push("");

  // The semantics nudge. A schema page carrying business meaning beside the columns is
  // worth more to a reader working from it than any format choice this page could make —
  // and those sentences come from `@description` on the entity and the field, which the
  // snapshot already threads here to emit `COMMENT ON`. A model declaring none renders a
  // page of names with nothing to disambiguate them, and says so, because silently
  // omitting the highest-value content teaches an adopter that it does not exist.
  const anyDescription =
    input.tables.some(
      (t) =>
        (t.description !== undefined && t.description !== "") ||
        t.columns.some((c) => c.description !== undefined && c.description !== ""),
    );
  if (!anyDescription && input.tables.length > 0) {
    out.push(
      "> **Nothing in this model declares a `description`.** The tables and columns below " +
        "are named but not explained. Adding `description` to an entity or a field is the " +
        "single highest-value change to this page: it is what tells a reader *which* of " +
        "two plausible columns to use, and it is the same text `meta migrate` emits as a " +
        "`COMMENT ON`, so it lands in the database too.",
    );
    out.push("");
  }

  if (input.tables.length > 0) {
    out.push("## Tables");
    out.push("");
    for (const table of [...input.tables].sort((a, b) => a.name.localeCompare(b.name))) {
      const key = input.qualify(table);
      out.push(
        ...tableSection(
          table,
          input,
          input.provenance.get(key),
          opts.declaredBy.get(key) ?? new Map(),
        ),
      );
    }
  }

  if (input.views.length > 0) {
    out.push("## Views");
    out.push("");
    out.push(
      "A view is generated from its projection's `origin.*` children — it is derived, " +
        "never hand-written. Editing the view SQL directly is drift the tool cannot see.",
    );
    out.push("");
    for (const view of [...input.views].sort((a, b) => a.name.localeCompare(b.name))) {
      const key = input.qualify(view);
      const qualified = view.schema === undefined ? `\`${view.name}\`` : `\`${view.schema}.${view.name}\``;
      out.push(`### ${qualified}`);
      out.push("");
      const fqn = input.provenance.get(key);
      if (fqn !== undefined) out.push(`Declared by \`${fqn}\`.`);
      const lineage = opts.viewLineage.get(key) ?? [];
      if (lineage.length > 0) {
        out.push("");
        out.push("| Column | Lineage |");
        out.push("|---|---|");
        out.push(...lineage);
      }
      out.push("");
    }
  }

  if (opts.relationships.length > 0) {
    out.push("## Relationships");
    out.push("");
    out.push(...opts.relationships);
    out.push("");
  }

  if (opts.enums.length > 0) {
    out.push("## Enums");
    out.push("");
    out.push(
      "Members are the values the wire and the generated types use. The column carries a " +
        "`CHECK`, so a value outside the set is refused by the database.",
    );
    out.push("");
    out.push(...opts.enums);
    out.push("");
  }

  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
