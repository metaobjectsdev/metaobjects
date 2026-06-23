// Projection declaration template — emits a Drizzle view declaration,
// a Zod read schema, the TS type via z.infer, and a constants block.
//
// This is the read-only counterpart to entity-file.ts.
// It does NOT emit:
//   - Drizzle table declaration (view-only)
//   - Zod Insert/Update schemas
//   - Insert/Update types

import { code, imp, joinCode, type Code } from "ts-poet";
import { MetaField, MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { projectionViewName } from "../projection/extract-view-spec.js";
import { columnNameFromField, toSnakeCase, pluralize } from "../naming.js";
import { GENERATED_HEADER } from "../constants.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import { mapColumnType } from "../column-mapper.js";
import { renderFilterAllowlist, renderSortAllowlist } from "./filter-allowlist.js";
import { renderFilterType } from "./filter-type.js";
import { inferViewKind, zodTypeFor, currencyMetaFor, labelFor } from "./field-meta.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ProjectionDeclOpts {
  readonly columnNamingStrategy: ColumnNamingStrategy;
  readonly dialect: "postgres" | "sqlite";
  readonly apiPrefix?: string;
  /** Drives the timestamp column TS type (Date vs string) in the view declaration. */
  readonly timestampMode?: "date" | "string";
  /**
   * When false, omit the Fastify-flavored filter/sort allowlists (and their
   * `runtime-ts` import) — mirrors entity-file's `allowlists` option so a
   * dependency-free consumer (no runtime-ts) gets compilable output.
   */
  readonly allowlists?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a PascalCase projection name to a kebab-pluralized URL path.
 *   "ProgramSummary"  → "/program-summaries"
 *   "CustomerSummary" → "/customer-summaries"
 *   "Box"             → "/boxes"
 *   "Wish"            → "/wishes"
 */
function pathFromProjectionName(name: string): string {
  const kebab = toSnakeCase(pluralize(name)).replace(/_/g, "-");
  return `/${kebab}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a TypeScript module for a projection entity. Emits:
 *   - `<camel>View`          — Drizzle `pgView` / `sqliteView` with `.existing()`
 *   - `<Projection>Schema`   — Zod read schema (no insert/update)
 *   - `<Projection>`         — `z.infer` type alias
 *   - `<Projection>` const   — constants block ($entity, $view, $path, per-field metadata)
 *
 * @param projection  The projection entity (has a source[dbView] child).
 * @param root        The loader's root (all top-level objects as direct children,
 *                    from `MetaDataLoader.load()` or `MetaDataLoader.fromDirectory()` as `result.root`).
 * @param opts        Column naming strategy + dialect.
 */
export function renderProjectionDecl(
  projection: MetaObject,
  root: MetaRoot,
  opts: ProjectionDeclOpts,
): string {
  const { dialect, columnNamingStrategy, apiPrefix = "", timestampMode = "string", allowlists = true } = opts;

  const viewFn = dialect === "postgres" ? "pgView" : "sqliteView";
  const viewModule =
    dialect === "postgres" ? "drizzle-orm/pg-core" : "drizzle-orm/sqlite-core";
  const viewSym = imp(`${viewFn}@${viewModule}`);
  const z = imp("z@zod");

  // Read-model generation needs only the view name — NOT the join/DDL
  // resolution. Deriving it directly (instead of via extractViewSpec) lets a
  // standalone read-only view-entity — explicit columns, no `extends` — generate
  // its read model. The join-backed view DDL (extractViewSpec) still requires a
  // base; standalone views hand-author (or separately generate) their SQL.
  const viewName = projectionViewName(projection, columnNamingStrategy);

  // Collect fields: inherited from extends parent first, then projection-declared.
  const allFields: MetaField[] = [];
  const superModel = projection.superResolved;
  const superName = superModel?.name ?? projection.superRef;
  if (superName) {
    const baseObj =
      superModel instanceof MetaObject ? superModel : root.findObject(superName);
    if (baseObj) {
      // fields() returns effective fields, so inherited fields (from extends:/super:) are included.
      for (const f of baseObj.fields()) allFields.push(f);
    }
  }
  for (const f of projection.ownFields()) allFields.push(f);

  const zodLines: Code[] = allFields.map(
    (f) => code`  ${f.name}: ${z}.${zodTypeFor(f).replace(/^z\./, "")}`,
  );

  // Typed view column map for the Drizzle `.existing()` declaration — keyed by
  // projection field name, valued by the column builder for the (renamed)
  // physical view column, so `db.select().from(<view>)` is typed. Honors
  // `@dbColumnType` (e.g. a passthrough of a jsonb column). `.existing()` views
  // carry type + physical name only — no PK/default/notNull modifiers.
  const viewColumnLines: Code[] = allFields.map((f) => {
    const spec = mapColumnType(f, dialect, columnNamingStrategy, timestampMode);
    const colSym = imp(`${spec.fnName}@${spec.importModule}`);
    const optsArg =
      spec.fnOptions && Object.keys(spec.fnOptions).length > 0
        ? `, ${JSON.stringify(spec.fnOptions)}`
        : "";
    // Of the table modifiers, only `.notNull()` carries to an existing view (it
    // shapes the SELECT type); `.primaryKey()`/`.default()`/`.references()` are
    // table-DDL concerns and invalid on a `.existing()` view declaration.
    const notNull = spec.modifiers.includes(".notNull()") ? ".notNull()" : "";
    return code`  ${f.name}: ${colSym}(${JSON.stringify(spec.dbName)}${optsArg})${notNull}`;
  });

  const constFieldLines: string[] = allFields.map((f) => {
    const dbCol = columnNameFromField(f.name, columnNamingStrategy);
    const view = inferViewKind(f);
    const label = labelFor(f);
    const baseEntry = `name: ${JSON.stringify(f.name)}, label: ${JSON.stringify(label)}, view: ${JSON.stringify(view)}, dbCol: ${JSON.stringify(dbCol)}`;
    const currencyMeta = currencyMetaFor(f);
    if (currencyMeta !== null) {
      return `  ${f.name}: { ${baseEntry}, currency: ${JSON.stringify(currencyMeta.currency)}, locale: ${JSON.stringify(currencyMeta.locale)} },`;
    }
    return `  ${f.name}: { ${baseEntry} },`;
  });

  const projName = projection.name;
  const camelName = projName.charAt(0).toLowerCase() + projName.slice(1);
  const path = pathFromProjectionName(projName);

  const sections: Code[] = [
    code`
// View declaration — Drizzle uses this for typed SELECT queries.
// The SQL view is created/managed by migrate-ts; .existing() tells Drizzle
// not to attempt DDL for this declaration.
export const ${camelName}View = ${viewSym}(${JSON.stringify(viewName)}, {
${joinCode(viewColumnLines, { on: ",\n" })}
}).existing();
`,
    code`
export const ${projName}Schema = ${z}.object({
${joinCode(zodLines, { on: ",\n" })}
});
`,
    code`
export type ${projName} = ${z}.infer<typeof ${projName}Schema>;
`,
    code`
export const ${projName} = {
  $entity:    ${JSON.stringify(projName)},
  $view:      ${JSON.stringify(viewName)},
  $path:      ${JSON.stringify(path)},
  $apiPrefix: ${JSON.stringify(apiPrefix)},
${constFieldLines.join("\n")}
} as const;
`,
    ...(allowlists
      ? [renderFilterAllowlist(projection), renderSortAllowlist(projection)]
      : []),
    renderFilterType(projection),
  ];

  const body = joinCode(sections, { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${projName} (${projection.fqn()})\n`;
  return header + body;
}
