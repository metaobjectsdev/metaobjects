// Shared Drizzle `.existing()` view declaration builder.
//
// A view-backed read model — a projection (read-only, view-only) OR the replica
// view of a write-through entity (FR-024 §7, #214) — declares its physical SQL
// view to Drizzle via `<viewVar> = pgView/sqliteView(<name>, { …cols }).existing()`
// so `db.select().from(<viewVar>)` is typed and `.existing()` tells Drizzle not to
// attempt DDL (the SQL view is created/owned by migrate-ts). Both hosts emit the
// SAME declaration shape, so it lives here once (extracted from projection-decl).

import { code, imp, joinCode, type Code } from "ts-poet";
import {
  type MetaField, FIELD_SUBTYPE_OBJECT, FIELD_ATTR_OBJECT_REF, stripPackage,
} from "@metaobjectsdev/metadata";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import { mapColumnType } from "../column-mapper.js";
import { zodTypeFor } from "./field-meta.js";

export interface ViewDeclOpts {
  readonly dialect: "postgres" | "sqlite";
  readonly columnNamingStrategy: ColumnNamingStrategy;
  /** Drives the timestamp column TS type (Date vs string) in the view declaration. */
  readonly timestampMode: "date" | "string";
  /** Resolve a value-object short name → its import module specifier. */
  readonly voModule: (refBase: string) => string;
}

/**
 * The typed view column map for a Drizzle `.existing()` declaration — keyed by
 * field name, valued by the column builder for the (renamed) physical view column,
 * so `db.select().from(<view>)` is typed. Honors `@dbColumnType`; `.existing()`
 * views carry type + physical name only (no PK/default/notNull DDL modifiers).
 */
function viewColumnLine(f: MetaField, opts: ViewDeclOpts): Code {
  const { dialect, columnNamingStrategy, timestampMode, voModule } = opts;
  const spec = mapColumnType(f, dialect, columnNamingStrategy, timestampMode);
  const colSym = imp(`${spec.fnName}@${spec.importModule}`);
  const optsArg =
    spec.fnOptions && Object.keys(spec.fnOptions).length > 0
      ? `, ${JSON.stringify(spec.fnOptions)}`
      : "";
  // #204 — of the table modifiers, only `.array()` (postgres native array element
  // typing) and `.notNull()` (shapes the SELECT type) carry to an existing view;
  // `.primaryKey()`/`.default()`/`.references()`/`.unique()` are table-DDL concerns
  // and invalid on a `.existing()` view declaration. Preserve the canonical order.
  const viewModifiers = spec.modifiers
    .filter((m) => m === ".array()" || m === ".notNull()")
    .join("");
  // Narrow the column to its resolved element/value type — `.$type<…>()` — mirroring
  // the entity column so the read row is typed (not `unknown`) and an array column
  // reads as `T[]`, not `T`.
  let dollarType: Code | string = "";
  const dtr = spec.dollarTypeRef;
  if (dtr?.kind === "scalar") {
    dollarType = `.$type<${dtr.tsType}${dtr.array ? "[]" : ""}>()`;
  } else if (dtr?.kind === "objectRef") {
    const voTypeSym = imp(`${dtr.name}@${voModule(dtr.name)}`);
    dollarType = dtr.array ? code`.$type<${voTypeSym}[]>()` : code`.$type<${voTypeSym}>()`;
  } else if (dtr?.kind === "map") {
    dollarType = "scalar" in dtr.value
      ? `.$type<Record<string, ${dtr.value.scalar}>>()`
      : code`.$type<Record<string, ${imp(`${dtr.value.objectRef}@${voModule(dtr.value.objectRef)}`)}>>()`;
  }
  return code`  ${f.name}: ${colSym}(${JSON.stringify(spec.dbName)}${optsArg})${dollarType}${viewModifiers}`;
}

/**
 * Emit `export const <viewVar> = <viewFn>(<viewName>, { …cols }).existing();` for a
 * view-backed read model (projection or write-through replica view). `fields` are the
 * view's exposed columns (already resolved to effective fields by the caller).
 */
export function renderExistingViewDecl(
  fields: readonly MetaField[],
  viewName: string,
  viewVar: string,
  opts: ViewDeclOpts,
): Code {
  const viewFn = opts.dialect === "postgres" ? "pgView" : "sqliteView";
  const viewModule = opts.dialect === "postgres" ? "drizzle-orm/pg-core" : "drizzle-orm/sqlite-core";
  const viewSym = imp(`${viewFn}@${viewModule}`);
  const viewColumnLines = fields.map((f) => viewColumnLine(f, opts));
  return code`
// View declaration — Drizzle uses this for typed SELECT queries.
// The SQL view is created/managed by migrate-ts; .existing() tells Drizzle
// not to attempt DDL for this declaration.
export const ${viewVar} = ${viewSym}(${JSON.stringify(viewName)}, {
${joinCode(viewColumnLines, { on: ",\n" })}
}).existing();
`;
}

/**
 * The Zod object body for a view-backed read model — one `field: z.<type>[.nullable()]`
 * line per column, the read counterpart of {@link renderExistingViewDecl}. A column that
 * is not `.notNull()` in the view is `.nullable()` (Drizzle's SELECT infers `T | null`),
 * so `z.infer<>` of the object equals the view row type. This is the dialect-agnostic read
 * type (a Drizzle view exposes `$inferSelect` on Postgres but not SQLite). A `field.object`
 * passthrough carries the value-object's schema so the read type exposes the VO shape.
 * `voModule` resolves a value-object short name → its import module.
 */
export function renderViewReadZodObject(fields: readonly MetaField[], opts: ViewDeclOpts): Code {
  const { dialect, columnNamingStrategy, timestampMode, voModule } = opts;
  const z = imp("z@zod");
  const lines: Code[] = fields.map((f) => {
    const nullable =
      mapColumnType(f, dialect, columnNamingStrategy, timestampMode).modifiers.includes(".notNull()")
        ? ""
        : ".nullable()";
    const refBase =
      f.subType === FIELD_SUBTYPE_OBJECT
        ? (() => {
            const ref = f.attr(FIELD_ATTR_OBJECT_REF);
            return typeof ref === "string" && ref.length > 0 ? stripPackage(ref) : undefined;
          })()
        : undefined;
    if (refBase) {
      const schemaSym = imp(`${refBase}InsertSchema@${voModule(refBase)}`);
      const base = f.resolvedIsArray() ? code`${z}.array(${schemaSym})` : code`${schemaSym}`;
      return code`  ${f.name}: ${base}${nullable}`;
    }
    // #204 — an array passthrough reads as `T[]`; zodTypeFor returns the ELEMENT type.
    const inner = code`${z}.${zodTypeFor(f).replace(/^z\./, "")}`;
    const zbase = f.resolvedIsArray() ? code`${z}.array(${inner})` : inner;
    return code`  ${f.name}: ${zbase}${nullable}`;
  });
  return code`${z}.object({
${joinCode(lines, { on: ",\n" })}
})`;
}
