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
//
// BUILDER, THEN TEMPLATE. `agentSchemaPageData` makes every cell and line; the shared
// template `templates/agent/schema.md.mustache` lays them out, and every port renders it
// from the same data (`fixtures/docs-page-conformance/`). `physical: false` is the page a
// port without the expected schema writes (design call 17): no SQL type column, no
// indexes, no checks — the dialect-only facts. Everything else is derivable from the model.

import {
  CARDINALITY_MANY,
  CARDINALITY_ONE,
  FIELD_SUBTYPE_ENUM,
  GENERATION_INCREMENT,
  GENERATION_UUID,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  ORIGIN_ATTR_ORDER_BY,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_SUBTYPE_COMPUTED,
  ORIGIN_SUBTYPE_FIRST,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  PHYSICAL_NAME_ATTR_BY_KIND,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_ON_DELETE,
  RELATIONSHIP_ATTR_THROUGH,
  SOURCE_ROLE_PRIMARY,
  TYPE_ORIGIN,
  resolveColumnName,
} from "@metaobjectsdev/metadata";
import type { ColumnNamingStrategy, MetaField, MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import type { Provider } from "@metaobjectsdev/render";
import { GENERATED_HEADER } from "../constants.js";
import { enumValues, intValueMapOf } from "../enum-meta.js";
import { isAbstract } from "../instance-artifacts.js";
import { resolveObjectNames } from "../names.js";
import { frameworkTemplatesProvider } from "../render-engine/framework-provider.js";
import { renderDocPage } from "../render-engine/doc-page.js";
import { isReport } from "../source-detect.js";
import type {
  AgentSchemaInput,
  SchemaColumnLike,
  SchemaFkLike,
  SchemaIndexLike,
  SchemaTableLike,
} from "./agent-schema-input.js";

/** The shared template of `agent/schema.md`. */
export const AGENT_SCHEMA_PAGE_REF = "agent/schema.md";

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
function keyCell(table: SchemaTableLike, column: SchemaColumnLike, physical: boolean): string {
  const roles: string[] = [];
  if (table.primaryKey.includes(column.name)) {
    roles.push(table.primaryKey.length > 1 ? "PK (composite)" : "PK");
  }
  const fk = table.foreignKeys.find((f) => f.columns.includes(column.name));
  if (fk !== undefined) roles.push(`FK → \`${fk.refTable}\``);
  // An index is a dialect fact: a model-only page states the keys the model declares.
  const covering = physical ? table.indexes.filter((i) => i.columns.includes(column.name)) : [];
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
  if (column.identity === GENERATION_INCREMENT) return "auto-increment";
  if (column.identity === GENERATION_UUID) return "generated uuid";
  if (column.default === undefined) return "";
  return `\`${mdCell(column.default.value)}\``;
}

/**
 * The key columns, each carrying its direction when it is not the default.
 *
 * `desc` is written where it applies rather than only when the whole index is descending: a
 * mixed `(a ASC, b DESC)` index is a different index from `(a, b)`, and a reader deciding
 * whether an existing index serves their ORDER BY needs the per-column answer.
 */
function keyColumns(ix: SchemaIndexLike): string {
  return ix.columns
    .map((c, i) => (ix.orders?.[i] === "desc" ? `\`${c}\` desc` : `\`${c}\``))
    .join(", ");
}

function indexLine(ix: SchemaIndexLike): string {
  const key = ix.expr !== undefined ? `\`${mdCell(ix.expr)}\`` : keyColumns(ix);
  const parts = [`\`${ix.name}\``, ix.unique ? "unique" : "index", `on ${key}`];
  if (ix.using !== undefined && ix.using !== "" && ix.using !== "btree") parts.push(`using \`${ix.using}\``);
  if (ix.where !== undefined && ix.where !== "") parts.push(`where \`${mdCell(ix.where)}\``);
  return parts.join(" · ");
}

/**
 * A model-only page states the key alone. The constraint NAME comes from the schema
 * conventions and the referential ACTIONS from the expected schema's resolution ladder (the
 * reference, then its relationship, then the reverse one, then the subtype's default), and
 * only the expected schema applies either. The Relationships section carries the actions the
 * model authored.
 */
function fkLine(fk: SchemaFkLike, physical: boolean): string {
  const key = `${cols(fk.columns)} → \`${fk.refTable}\`(${cols(fk.refColumns)})`;
  if (!physical) return key;
  const parts = [`\`${fk.name}\``, key];
  if (fk.onDelete !== undefined && fk.onDelete !== "") parts.push(`on delete \`${fk.onDelete}\``);
  if (fk.onUpdate !== undefined && fk.onUpdate !== "") parts.push(`on update \`${fk.onUpdate}\``);
  return parts.join(" · ");
}

/** One `origin.*` child rendered as a lineage phrase. `origin.*` NEVER inherits, so the
 *  own-accessor read here is the correct one rather than an ADR-0039 slip. */
function lineageOf(field: MetaField): string | undefined {
  const origin = field.ownChildren().find((c) => c.type === TYPE_ORIGIN);
  if (origin === undefined) return undefined;
  // Human-facing text: references print as the author wrote them (ADR-0059).
  const str = (name: string): string | undefined => {
    const v = origin.authoredAttr(name);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  switch (origin.subType) {
    case ORIGIN_SUBTYPE_PASSTHROUGH: {
      const from = str(ORIGIN_PASSTHROUGH_ATTR_FROM);
      const via = str(ORIGIN_PASSTHROUGH_ATTR_VIA);
      return `passthrough from \`${from ?? "?"}\`${via === undefined ? "" : ` via \`${via}\``}`;
    }
    case ORIGIN_SUBTYPE_AGGREGATE: {
      const agg = str(ORIGIN_AGGREGATE_ATTR_AGG) ?? "?";
      const of = str(ORIGIN_AGGREGATE_ATTR_OF);
      const via = str(ORIGIN_AGGREGATE_ATTR_VIA);
      return `\`${agg}\`${of === undefined ? "" : ` of \`${of}\``}${via === undefined ? "" : ` via \`${via}\``}`;
    }
    case ORIGIN_SUBTYPE_FIRST: {
      const of = str(ORIGIN_AGGREGATE_ATTR_OF);
      const via = str(ORIGIN_AGGREGATE_ATTR_VIA);
      const order = str(ORIGIN_ATTR_ORDER_BY);
      return `first${of === undefined ? "" : ` \`${of}\``}${via === undefined ? "" : ` via \`${via}\``}` +
        `${order === undefined ? "" : ` ordered by \`${order}\``}`;
    }
    case ORIGIN_SUBTYPE_COMPUTED:
      // The @expr tree is structured; naming it is enough to route a reader to the
      // declaration, and rendering a tree into a cell would be a second SQL lowering.
      return "computed from a declared `@expr`";
    default:
      return `\`origin.${origin.subType}\``;
  }
}

/**
 * The cardinality phrase, from the DECLARING object's side.
 *
 * `@cardinality: one` does NOT mean one-to-one. It means this object holds the foreign
 * key — many rows of it point at one target row — which is what `relation-resolver.ts`
 * builds a belongs-to `one()` relation from. Rendering it as "one-to-one" told a reader
 * the target row is claimed by at most one row here, which is the direction that makes
 * someone write a lookup expecting a single result.
 *
 * `@cardinality` is OPTIONAL vocabulary (min 0), and ABSENT is its own answer: no
 * navigation is generated at all. Folding that into "one-to-one" invented a shape the
 * model never declared.
 */
function cardinalityPhrase(cardinality: unknown, through: unknown): string {
  if (cardinality === CARDINALITY_MANY) {
    return typeof through === "string" && through !== "" ? "many-to-many" : "one-to-many";
  }
  if (cardinality === CARDINALITY_ONE) return "many-to-one";
  return "cardinality not declared";
}

/** `\`Order.lines\` · \`association\` · one-to-many → \`OrderLine\``: one line each, no bullet. */
function relationshipLines(objects: readonly MetaObject[]): string[] {
  const out: string[] = [];
  for (const obj of objects) {
    for (const rel of obj.relationships()) {
      const cardinality = rel.attr(RELATIONSHIP_ATTR_CARDINALITY);
      // References print as the author wrote them (ADR-0059); the loaded value is canonical.
      const target = rel.authoredAttr(RELATIONSHIP_ATTR_OBJECT_REF);
      const through = rel.authoredAttr(RELATIONSHIP_ATTR_THROUGH);
      const onDelete = rel.attr(RELATIONSHIP_ATTR_ON_DELETE);
      // The FQN, not the short name: this line is an ADDRESS a reader searches for.
      const parts = [`\`${obj.resolutionKey()}.${rel.name}\``, `\`${rel.subType}\``];
      parts.push(
        `${cardinalityPhrase(cardinality, through)} → \`${String(target ?? "?")}\``,
      );
      if (typeof through === "string" && through !== "") parts.push(`through \`${through}\``);
      if (typeof onDelete === "string" && onDelete !== "") parts.push(`on delete \`${onDelete}\``);
      out.push(parts.join(" · "));
    }
  }
  return out;
}

/**
 * One enum row: `Order.status`, its members, its storage.
 *
 * `objects` IS ONLY THE TABLE-BACKED SUBSET OF THE MODEL — the caller scopes it to the
 * objects the snapshot actually holds as tables. This section sits on the SCHEMA page, so
 * every row it prints is read as a statement about a column. Walking every loaded object
 * printed rows for abstract bases, for `object.value`s that have no column anywhere, and
 * for projections whose "column" is a view expression — three kinds of thing the physical
 * schema does not contain.
 *
 * It also says nothing about a `CHECK`. Whether the database constrains the members is
 * `table.checks`, which is already on this page from the snapshot, and an `@isArray`
 * enum deliberately gets none (`migrate-ts` skips it) — so asserting one here was a
 * SECOND derivation of a fact the page already carries correctly, in the direction that
 * promises the database will refuse a value it will accept.
 */
function enumRows(objects: readonly MetaObject[]): AgentSchemaEnumRow[] {
  const rows: AgentSchemaEnumRow[] = [];
  for (const obj of objects) {
    for (const field of obj.fields()) {
      if (field.subType !== FIELD_SUBTYPE_ENUM) continue;
      const members = enumValues(field);
      if (members === undefined || members.length === 0) continue;
      const intMap = intValueMapOf(field);
      const storage =
        intMap === undefined
          ? "string-backed"
          : `int-backed (${members.map((m) => `${m}=${intMap[m]}`).join(", ")})`;
      rows.push({
        field: `${obj.resolutionKey()}.${field.name}`,
        members: members.map((m) => `\`${m}\``).join(", "),
        storage,
      });
    }
  }
  return rows;
}

/** One column row of a table, every cell finished. `sqlTypeCell` and `defaultCell` are ""
 *  on a model-only page, which has neither column. */
export interface AgentSchemaColumnRow {
  readonly name: string;
  readonly fieldCell: string;
  readonly declaredCell: string;
  readonly sqlTypeCell: string;
  readonly nullCell: string;
  readonly defaultCell: string;
  readonly keyCell: string;
}

export interface AgentSchemaTable {
  /** The qualified name in backticks: `` `schema.name` `` or `` `name` ``. */
  readonly heading: string;
  readonly tableDeclaredBy?: string;
  readonly tableDescription?: string;
  readonly columns: readonly AgentSchemaColumnRow[];
  readonly hasDescribed: boolean;
  readonly described: readonly { readonly name: string; readonly text: string }[];
  readonly hasIndexes: boolean;
  readonly indexes: readonly string[];
  readonly hasForeignKeys: boolean;
  readonly foreignKeys: readonly string[];
  readonly hasChecks: boolean;
  readonly checks: readonly string[];
}

export interface AgentSchemaView {
  readonly heading: string;
  readonly viewDeclaredBy?: string;
  readonly hasLineage: boolean;
  readonly lineage: readonly { readonly column: string; readonly text: string }[];
}

export interface AgentSchemaEnumRow {
  /** `pkg::Order.status` — the address a reader searches for. */
  readonly field: string;
  readonly members: string;
  readonly storage: string;
}

/** What `agent/schema.md.mustache` renders. */
export interface AgentSchemaPageData {
  readonly generatedMarker: string;
  /** True when the page carries the dialect facts: SQL types, indexes, checks. */
  readonly physical: boolean;
  /** The dialect a physical page names; `""` on a model-only page. */
  readonly dialect: string;
  /** The project chose a `meta migrate` dialect: the page tells a reader to change the schema
   *  with `meta migrate`. Otherwise with the project's own migration tool, fed by `meta schema`. */
  readonly hasMigrate: boolean;
  readonly descriptionNudge: boolean;
  readonly hasTables: boolean;
  readonly tables: readonly AgentSchemaTable[];
  readonly hasViews: boolean;
  /** True when a view-backed `object.report` owns one of the views: the intro names reports too. */
  readonly hasReportView: boolean;
  readonly views: readonly AgentSchemaView[];
  readonly hasRelationships: boolean;
  readonly relationships: readonly string[];
  readonly hasEnums: boolean;
  readonly enums: readonly AgentSchemaEnumRow[];
}

/**
 * What the model contributes to the page: per qualified table or view name, the column →
 * declaring-field map and the view lineage; the qualified names report views own; and the
 * relationship and enum rows.
 */
interface ModelFacts {
  readonly declaredBy: ReadonlyMap<string, ReadonlyMap<string, { field: string; type: string }>>;
  readonly viewLineage: ReadonlyMap<string, readonly { column: string; text: string }[]>;
  readonly reportViews: ReadonlySet<string>;
  readonly relationships: readonly string[];
  readonly enums: readonly AgentSchemaEnumRow[];
}

function modelFacts(root: MetaRoot, schema: AgentSchemaInput, columnNamingStrategy: ColumnNamingStrategy): ModelFacts {
  const objects = root.objects();
  // The qualified names the snapshot actually holds. An object whose physical name is not
  // one of these contributes nothing to the physical schema (an abstract base, a sourceless
  // value, an `@unmanaged` object) and must not appear on a page describing it —
  // `buildExpectedSchema`'s Pass 1 owns those skip rules and this reads its answer rather
  // than re-deriving them.
  const tableNames = new Set(schema.tables.map((t) => schema.qualify(t)));
  const viewNames = new Set(schema.views.map((v) => schema.qualify(v)));
  // The objects backed by a TABLE in the snapshot — the enum section's scope, since a row
  // there is read as a statement about a column.
  const tableBacked: MetaObject[] = [];
  // column → declaring field, per qualified table name. `resolveObjectNames` is the ONE
  // field→column resolver — the same one the names artifact and the DDL use — so this
  // mapping cannot disagree with the column it labels.
  const declaredBy = new Map<string, Map<string, { field: string; type: string }>>();
  const viewLineage = new Map<string, { column: string; text: string }[]>();
  // Qualified names of the views a view-backed object.report owns (FR-044). Empty for a
  // model with no report, so the page is byte-identical to what it was before reports.
  const reportViews = new Set<string>();
  for (const obj of objects) {
    const names = resolveObjectNames(obj, columnNamingStrategy);
    // The PRIMARY source's physical name and schema — `names.name` is the object's
    // metamodel name since 0.25.0, which would match nothing in the snapshot.
    const primary = names?.sources[SOURCE_ROLE_PRIMARY];
    const physical = primary === undefined
      ? undefined
      : primary[(PHYSICAL_NAME_ATTR_BY_KIND.get(primary.kind) ?? "") as keyof typeof primary];
    if (typeof physical !== "string") continue;
    const key = schema.qualify({ name: physical, schema: primary?.schema });
    const isTable = tableNames.has(key);
    if (!isTable && !viewNames.has(key)) continue;
    // ABSTRACT BASES ARE EXCLUDED, and being in the snapshot does not exempt them: an
    // abstract base that declares the `source.rdb` its concrete child inherits resolves to
    // that child's table, so the qualified-name test admits it and the page printed the
    // base's enum a second time under a different owner. `buildExpectedSchema`'s Pass 1
    // skips abstracts; this reads the same rule.
    if (isTable && !isAbstract(obj)) tableBacked.push(obj);
    if (!isTable && isReport(obj)) reportViews.add(key);
    let map = declaredBy.get(key);
    if (map === undefined) {
      map = new Map();
      declaredBy.set(key, map);
    }
    const lineage: { column: string; text: string }[] = [];
    for (const field of obj.fields()) {
      const column = resolveColumnName(field, columnNamingStrategy);
      // A TPH base and its subtypes share one table: first writer wins, so the base's own
      // column keeps its label rather than being relabelled by whichever subtype was
      // walked last.
      if (!map.has(column)) {
        map.set(column, { field: field.name, type: `${field.type}.${field.subType}` });
      }
      const text = lineageOf(field);
      if (text !== undefined) lineage.push({ column, text });
    }
    if (lineage.length > 0) viewLineage.set(key, lineage);
  }
  return { declaredBy, viewLineage, reportViews, relationships: relationshipLines(objects), enums: enumRows(tableBacked) };
}

function tableOf(
  table: SchemaTableLike,
  input: AgentSchemaInput,
  physical: boolean,
  fqn: string | undefined,
  declaredBy: ReadonlyMap<string, { field: string; type: string }>,
): AgentSchemaTable {
  const described = table.columns.filter((c) => c.description !== undefined && c.description !== "");
  // The dialect facts. A model-only page omits them: the expected schema is what knows them.
  const indexes = physical ? table.indexes.map(indexLine) : [];
  const checks = physical ? table.checks.map((ck) => `\`${ck.name}\` — \`${mdCell(ck.expression)}\``) : [];
  const foreignKeys = table.foreignKeys.map((fk) => fkLine(fk, physical));
  return {
    heading: table.schema === undefined ? `\`${table.name}\`` : `\`${table.schema}.${table.name}\``,
    ...(fqn !== undefined && { tableDeclaredBy: fqn }),
    ...(table.description !== undefined && table.description !== "" && { tableDescription: oneLine(table.description) }),
    // `declaredBy` maps a physical column name back to the FIELD that declared it — the
    // mapping an agent needs to go from a query it is reading to the metadata it must edit,
    // and the one thing the snapshot alone cannot supply.
    columns: table.columns.map((c) => {
      const declared = declaredBy.get(c.name);
      return {
        name: c.name,
        fieldCell: declared === undefined ? "" : `\`${declared.field}\``,
        declaredCell: declared === undefined ? "" : `\`${declared.type}\``,
        sqlTypeCell: physical ? `\`${mdCell(input.columnType(c))}\`` : "",
        nullCell: c.nullable ? "yes" : "no",
        // A default is written in the dialect's SQL spelling: a dialect fact.
        defaultCell: physical ? defaultCell(c) : "",
        keyCell: keyCell(table, c, physical),
      };
    }),
    // Column descriptions ride BELOW the table rather than as an eighth cell: a sentence
    // in a cell forces the whole table wide, and most columns have none.
    hasDescribed: described.length > 0,
    described: described.map((c) => ({ name: c.name, text: oneLine(c.description ?? "") })),
    hasIndexes: indexes.length > 0,
    indexes,
    hasForeignKeys: foreignKeys.length > 0,
    foreignKeys,
    hasChecks: checks.length > 0,
    checks,
  };
}

export interface AgentSchemaPageOptions {
  /** False writes the model-only page: no SQL type or default column, no indexes (in the
   *  Key column too), no checks, no constraint names, no referential actions. Default true. */
  readonly physical?: boolean;
  /** Where the template is resolved. Default: the package's own templates. */
  readonly provider?: Provider;
}

/**
 * The data the schema template renders. Undefined when there is no physical schema at all,
 * which is what lets the surface emit no FILE rather than a page describing nothing.
 */
export function agentSchemaPageData(
  root: MetaRoot,
  input: AgentSchemaInput,
  columnNamingStrategy: ColumnNamingStrategy,
  opts?: { readonly physical?: boolean },
): AgentSchemaPageData | undefined {
  if (input.tables.length === 0 && input.views.length === 0) return undefined;
  const physical = opts?.physical !== false;
  const facts = modelFacts(root, input, columnNamingStrategy);

  // The semantics nudge. A schema page carrying business meaning beside the columns is
  // worth more to a reader working from it than any format choice this page could make —
  // and those sentences come from `@description` on the entity and the field, which the
  // snapshot already threads here to emit `COMMENT ON`. A model declaring none renders a
  // page of names with nothing to disambiguate them, and says so, because silently
  // omitting the highest-value content teaches an adopter that it does not exist.
  const anyDescription = input.tables.some(
    (t) =>
      (t.description !== undefined && t.description !== "") ||
      t.columns.some((c) => c.description !== undefined && c.description !== ""),
  );
  const tables = [...input.tables]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((table) => {
      const key = input.qualify(table);
      return tableOf(table, input, physical, input.provenance.get(key), facts.declaredBy.get(key) ?? new Map());
    });
  const views = [...input.views]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((view): AgentSchemaView => {
      const key = input.qualify(view);
      const fqn = input.provenance.get(key);
      const lineage = facts.viewLineage.get(key) ?? [];
      return {
        heading: view.schema === undefined ? `\`${view.name}\`` : `\`${view.schema}.${view.name}\``,
        ...(fqn !== undefined && { viewDeclaredBy: fqn }),
        hasLineage: lineage.length > 0,
        lineage,
      };
    });
  return {
    generatedMarker: GENERATED_MARKER,
    physical,
    dialect: physical ? input.dialect : "",
    hasMigrate: input.migrate,
    descriptionNudge: !anyDescription && input.tables.length > 0,
    hasTables: tables.length > 0,
    tables,
    hasViews: views.length > 0,
    // A model with no report view must render exactly what it rendered before FR-044
    // (no-churn: `meta verify --codegen` would flag drift after an upgrade otherwise).
    hasReportView: input.views.some((v) => facts.reportViews.has(input.qualify(v))),
    views,
    hasRelationships: facts.relationships.length > 0,
    relationships: facts.relationships,
    hasEnums: facts.enums.length > 0,
    enums: facts.enums,
  };
}

/** Render the whole page; "" when there is no physical schema at all. */
export function renderAgentSchemaPage(
  root: MetaRoot,
  input: AgentSchemaInput,
  columnNamingStrategy: ColumnNamingStrategy,
  opts?: AgentSchemaPageOptions,
): string {
  const data = agentSchemaPageData(root, input, columnNamingStrategy, opts);
  if (data === undefined) return "";
  const page = renderDocPage(AGENT_SCHEMA_PAGE_REF, data, opts?.provider ?? frameworkTemplatesProvider, "agent/schema.md");
  // A page ends on exactly one line break, whichever section came last.
  return `${page.replace(/\n+$/, "")}\n`;
}
