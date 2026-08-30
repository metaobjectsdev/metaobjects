// Projection declaration template — emits a Drizzle view declaration,
// a Zod read schema, the TS type via z.infer, and a constants block.
//
// This is the read-only counterpart to entity-file.ts.
// It does NOT emit:
//   - Drizzle table declaration (view-only)
//   - Zod Insert/Update schemas
//   - Insert/Update types

import { code, imp, joinCode, type Code } from "ts-poet";
import {
  MetaField, MetaObject, type MetaRoot, isMetaObject,
  FIELD_ATTR_OBJECT_REF, stripPackage, resolveColumnName,
} from "@metaobjectsdev/metadata";
import { projectionViewName } from "../projection/extract-view-spec.js";
import { toSnakeCase, pluralize } from "../naming.js";
import { GENERATED_HEADER } from "../constants.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import { fieldDeclaringPackage, type RenderContext } from "../render-context.js";
import { valueObjectModuleSpecifier } from "../import-path.js";
import { renderFilterAllowlist, renderSortAllowlist } from "./filter-allowlist.js";
import { renderFilterType } from "./filter-type.js";
import { inferViewKind, currencyMetaFor, labelFor } from "./field-meta.js";
import { renderExistingViewDecl, renderViewReadZodObject } from "./view-decl.js";
import { primaryIdentityFieldNames } from "./zod-validators.js";

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
  /**
   * Render context, when available — used to resolve value-object import MODULES
   * (`.$type<VO>()` + the VO Zod schema) in a layout/package/extStyle-aware way.
   * Absent in bare unit-test calls, which fall back to a flat same-dir import.
   */
  readonly ctx?: RenderContext;
  /**
   * Whether to emit the Drizzle `.existing()` view declaration (and its
   * drizzle-orm import). Default true. Set false for a contract-only output
   * (Zod read schema + inferred type + constants, no runtime DB dependency) —
   * e.g. a shared types package consumed by a web client that has no Drizzle.
   */
  readonly includeViewDecl?: boolean;
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
  const { dialect, columnNamingStrategy, apiPrefix = "", timestampMode = "string", allowlists = true, ctx, includeViewDecl = true } = opts;

  // ADR-0044/#228 — resolve a projection field's `@objectRef` to the value object's
  // EMITTED name + module TOGETHER (lock-step): bare when unique in the run,
  // package-qualified on a cross-package short-name collision, so the projection's
  // VO import matches the entity's. Layout/package/extStyle-aware when a render
  // context is present, else a flat same-dir import (zodFieldExpr's fallback).
  const voRef = (field: MetaField): { name: string; module: string } => {
    const ref = field.attr(FIELD_ATTR_OBJECT_REF);
    const rawRef = typeof ref === "string" ? ref : "";
    const name = ctx
      ? ctx.resolveValueObjectName(rawRef, fieldDeclaringPackage(field, projection.package))
      : stripPackage(rawRef);
    const module = ctx
      ? valueObjectModuleSpecifier(name, ctx.packageOf, projection.package, ctx.outputLayout, ctx.extStyle)
      : `./${name}.js`;
    return { name, module };
  };

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
      isMetaObject(superModel) ? superModel : root.findObject(superName);
    if (baseObj) {
      // fields() returns effective fields, so inherited fields (from extends:/super:) are included.
      for (const f of baseObj.fields()) allFields.push(f);
    }
  }
  // ADR-0039: own — category 1 (emit-declared-here): the super's effective fields
  // were already collected above; append only the projection's OWN new fields so
  // inherited fields are not duplicated.
  for (const f of projection.ownFields()) allFields.push(f);

  const constFieldLines: string[] = allFields.map((f) => {
    // §A4: resolveColumnName, NOT columnNameFromField — the latter takes a string and so
    // cannot read @column, silently substituting the naming strategy's answer for a
    // declared or inherited physical name. ADR-0039: resolving accessor, so a projection
    // field inheriting @column through `extends` resolves it.
    const dbCol = resolveColumnName(f, columnNamingStrategy);
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

  // The projection's primary-identity fields type non-null in the view decl +
  // read schema even without @required (a PK is never NULL; see ViewDeclOpts).
  const pkFieldNames: ReadonlySet<string> = new Set(primaryIdentityFieldNames(projection));
  const sections: Code[] = [
    ...(includeViewDecl
      ? [renderExistingViewDecl(allFields, viewName, `${camelName}View`, {
          dialect, columnNamingStrategy, timestampMode, voRef, pkFieldNames,
        })]
      : []),
    code`
export const ${projName}Schema = ${renderViewReadZodObject(allFields, {
  dialect, columnNamingStrategy, timestampMode, voRef, pkFieldNames,
})};
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
      ? [renderFilterAllowlist(projection, undefined, ctx), renderSortAllowlist(projection)]
      : []),
    renderFilterType(projection),
  ];

  const body = joinCode(sections, { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${projName} (${projection.fqn()})\n`;
  return header + body;
}
