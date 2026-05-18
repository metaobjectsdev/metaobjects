// Projection declaration template — emits a Drizzle view declaration,
// a Zod read schema, the TS type via z.infer, and a constants block.
//
// This is the read-only counterpart to entity-file.ts.
// It does NOT emit:
//   - Drizzle table declaration (view-only)
//   - Zod Insert/Update schemas
//   - Insert/Update types

import { code, imp, joinCode, type Code } from "ts-poet";
import type { MetaData } from "@metaobjects/metadata";
import { MetaField } from "@metaobjects/metadata";
import {
  TYPE_FIELD,
} from "@metaobjects/metadata";
import { extractViewSpec } from "../projection/extract-view-spec.js";
import { columnNameFromField, toSnakeCase, pluralize } from "../naming.js";
import { GENERATED_HEADER } from "../constants.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
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
 * @param projection  The projection entity MetaData (has a source[dbView] child).
 * @param root        The loader's root MetaData (all top-level objects as direct children,
 *                    from `MetaDataLoader.load()` / `FileMetaDataLoader.loadFiles()` as `result.root`).
 * @param opts        Column naming strategy + dialect.
 */
export function renderProjectionDecl(
  projection: MetaData,
  root: MetaData,
  opts: ProjectionDeclOpts,
): string {
  const { dialect, columnNamingStrategy, apiPrefix = "" } = opts;

  const viewFn = dialect === "postgres" ? "pgView" : "sqliteView";
  const viewModule =
    dialect === "postgres" ? "drizzle-orm/pg-core" : "drizzle-orm/sqlite-core";
  const viewSym = imp(`${viewFn}@${viewModule}`);
  const z = imp("z@zod");

  const spec = extractViewSpec(projection, root, { columnNamingStrategy });

  // Collect fields: inherited from extends parent first, then projection-declared.
  const allFields: MetaData[] = [];
  const superModel = projection.superResolved;
  const superName = superModel?.name ?? projection.superRef;
  if (superName) {
    const baseObj =
      superModel ??
      (() => {
        for (const child of root.children()) {
          if (child.name === superName) return child;
        }
        return undefined;
      })();
    if (baseObj) {
      for (const f of baseObj.effectiveChildren()) {
        if (f.type === TYPE_FIELD) allFields.push(f);
      }
    }
  }
  for (const f of projection.children()) {
    if (f.type === TYPE_FIELD) allFields.push(f);
  }

  const zodLines: Code[] = allFields.map(
    // Transient cast: allFields contains MetaField instances; removed in Task 6.
    (f) => code`  ${f.name}: ${z}.${zodTypeFor(f as MetaField).replace(/^z\./, "")}`,
  );

  const constFieldLines: string[] = allFields.map((f) => {
    // Transient cast: allFields contains MetaField instances; removed in Task 6.
    const mf = f as MetaField;
    const dbCol = columnNameFromField(f.name, columnNamingStrategy);
    const view = inferViewKind(mf);
    const label = labelFor(mf);
    const baseEntry = `name: ${JSON.stringify(f.name)}, label: ${JSON.stringify(label)}, view: ${JSON.stringify(view)}, dbCol: ${JSON.stringify(dbCol)}`;
    const currencyMeta = currencyMetaFor(mf);
    if (currencyMeta !== null) {
      return `  ${f.name}: { ${baseEntry}, currency: ${JSON.stringify(currencyMeta.currency)}, locale: ${JSON.stringify(currencyMeta.locale)} },`;
    }
    return `  ${f.name}: { ${baseEntry} },`;
  });

  const projName = projection.name;
  const camelName = projName.charAt(0).toLowerCase() + projName.slice(1);
  const path = pathFromProjectionName(projName);
  const viewName = spec.viewName;

  const sections: Code[] = [
    code`
// View declaration — Drizzle uses this for typed SELECT queries.
// The SQL view is created/managed by migrate-ts; .existing() tells Drizzle
// not to attempt DDL for this declaration.
export const ${camelName}View = ${viewSym}(${JSON.stringify(viewName)}, {}).existing();
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
    renderFilterAllowlist(projection),
    renderSortAllowlist(projection),
    renderFilterType(projection),
  ];

  const body = joinCode(sections, { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${projName} (${projection.fqn()})\n`;
  return header + body;
}
