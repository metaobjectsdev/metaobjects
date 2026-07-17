// Inferred types template — emits Drizzle's InferSelectModel / InferInsertModel type aliases,
// plus named union types for field.enum fields.
//
// Also emits the structural TS interface for value-only objects (metaobjects
// with no writable source.rdb). That path side-steps Drizzle entirely: the
// interface is computed directly from the field tree, with `name?: T` for
// optional fields (matching Zod's `.optional()` inference — `T | undefined` —
// without the superfluous `| null` that Drizzle nullable columns introduce).

import { code, imp, joinCode, type Code } from "ts-poet";
import type { MetaObject, MetaField } from "@metaobjectsdev/metadata";
import {
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_MAP,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_URI,
  FIELD_SUBTYPE_INET,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_VALUE_TYPE,
  FIELD_ATTR_DB_COLUMN_TYPE,
  DB_COLUMN_TYPE_JSONB,
} from "@metaobjectsdev/metadata";
import { variableNameFromEntity, toPascalCase } from "../naming.js";
import { valueObjectModuleSpecifier } from "../import-path.js";
import { stripPackage } from "@metaobjectsdev/metadata";
import { enumValues } from "../enum-meta.js";
import { renderDocsFor } from "./jsdoc.js";
import { sharedEnumForField } from "../enum-shared.js";
import { sharedEnumImportSpecifier, providedEnumImportSpecifier } from "../enum-import.js";
import type { RenderContext } from "../render-context.js";

/**
 * Emit Drizzle's InferSelectModel / InferInsertModel aliases for an entity.
 *
 * `tphBase` (FR-017): when this entity is a TPH discriminator base, the
 * discriminated-union type (emitted by the tph-discriminator template) owns the
 * bare `<Base>` name, so the raw single-table row type is emitted as `<Base>Row`
 * to avoid a duplicate `export type <Base>`. Insert/Update keep their names
 * (no collision); they describe the physical TPH table row shape.
 */
export function renderInferredTypes(
  entity: MetaObject,
  tphBase = false,
  ctx?: RenderContext,
  skipRow = false,
): Code {
  // The inferred Row/Insert types reference the Drizzle table var, so they must
  // resolve to the SAME (possibly overridden) collection name the schema emits.
  // ctx is optional for bare unit-test calls — those fall back to the default
  // always-pluralize spelling.
  const varName = ctx ? ctx.collectionName(entity.name) : variableNameFromEntity(entity.name);
  // Type-only symbols (t: prefix) so ts-poet emits `import type` — otherwise a
  // value import of these types fails tsc under `verbatimModuleSyntax` (TS1484). (#165)
  const selectSym = imp("t:InferSelectModel@drizzle-orm");
  const insertSym = imp("t:InferInsertModel@drizzle-orm");
  const docs = renderDocsFor(entity);
  const docsPrefix = docs ? `${docs}\n` : "";
  const rowName = tphBase ? `${entity.name}Row` : entity.name;
  // #214 — a write-through entity read-view routes READS to the replica view, so the
  // read row type <Entity> is emitted from the VIEW's read schema (z.infer, carrying
  // the derived fields) by the entity-file composer, NOT here. `skipRow` suppresses
  // the table-inferred Row so there is no duplicate `export type <Entity>` (selectSym
  // then goes unreferenced and ts-poet drops its import). Insert/Update always stay
  // inferred from the write TABLE (derived-free, #213).
  if (skipRow) {
    return code`
export type ${entity.name}Insert = ${insertSym}<typeof ${varName}>;
export type ${entity.name}Update = Partial<${entity.name}Insert>;
`;
  }
  return code`
${docsPrefix}export type ${rowName} = ${selectSym}<typeof ${varName}>;
export type ${entity.name}Insert = ${insertSym}<typeof ${varName}>;
export type ${entity.name}Update = Partial<${entity.name}Insert>;
`;
}

/**
 * The string-literal-union type-alias name for a `field.enum` field — the SINGLE
 * source of truth for enum-union naming (reused by the entity inferred-types
 * emitter AND the payload-VO emitter so both agree byte-for-byte).
 *
 * - If the field extends an abstract field.enum (super), use the super field's
 *   PascalCase name (so multiple fields sharing one abstract enum collapse to a
 *   single alias).
 * - Otherwise use `<Owner><FieldPascal>` for inline enums, where `<Owner>` is the
 *   owning object's name (entity OR payload value-object).
 */
export function enumUnionAliasName(ownerName: string, field: MetaField): string {
  const superField = field.resolveSuper();
  return superField !== undefined
    ? toPascalCase(superField.name)
    : `${ownerName}${toPascalCase(field.name)}`;
}

/** The `"A" | "B"` union string for a set of enum member values. */
export function enumUnionString(values: string[]): string {
  return values.map((v) => JSON.stringify(v)).join(" | ");
}

/**
 * Emit the enum type-alias section for an entity file. Three cases per field:
 *
 *  • inline enum (members declared directly on the field; no root-abstract super)
 *    → `export type <Entity><Field> = "A" | "B";` — UNCHANGED (byte-identical).
 *  • shared materialized enum (extends a NON-@provided root-level abstract
 *    field.enum) → re-export the materialized type from the shared `./enums`
 *    module (`export { type E } from "./enums"`) instead of redeclaring it. The
 *    type is materialized ONCE in enums.ts (FR-019).
 *  • provided enum (extends a @provided root-level abstract field.enum) →
 *    re-export the type from the configured external module
 *    (`export { type E } from "<providedEnumModule>"`); metaobjects emits no
 *    declaration for it. A missing config is a codegen-time error.
 *
 * `ctx` is required to compute the shared/provided import specifiers. Returns
 * null when the entity has no enum-alias lines to emit.
 */
export function renderEnumTypeAliases(entity: MetaObject, ctx?: RenderContext): Code | null {
  // De-duplicate by type-alias name — multiple fields can extend the same abstract enum.
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const field of entity.fields()) {
    if (field.subType !== FIELD_SUBTYPE_ENUM) continue;

    const values = enumValues(field);
    if (values === undefined) continue;

    const typeName = enumUnionAliasName(entity.name, field);
    if (seen.has(typeName)) continue;
    seen.add(typeName);

    // Without a RenderContext (bare unit-test calls) the shared/provided import
    // specifiers can't be computed — fall back to inline emission. Real runs
    // always pass ctx (entity-file template), so shared materialization applies.
    const shared = ctx !== undefined ? sharedEnumForField(field) : undefined;
    if (shared === undefined) {
      // Inline enum — emit the literal union exactly as before.
      lines.push(`export type ${typeName} = ${enumUnionString(values)};`);
      continue;
    }
    // Shared / provided enum — re-export from the materialized module or the
    // configured external module; never redeclare the union here.
    const spec = shared.provided
      ? providedEnumImportSpecifier(ctx!, shared.name)
      : sharedEnumImportSpecifier(ctx!, entity.package);
    lines.push(`export { type ${shared.name} } from ${JSON.stringify(spec)};`);
  }

  return lines.length > 0 ? code`${lines.join("\n")}` : null;
}

// ---------------------------------------------------------------------------
// Value-object interface emitter
// ---------------------------------------------------------------------------

const SCALAR_TS_BY_SUBTYPE: Record<string, string> = {
  [FIELD_SUBTYPE_STRING]: "string",
  [FIELD_SUBTYPE_UUID]: "string",
  // ADR-0036/0037 Wave 3: uri/inet bind to TS `string` (TS has no native URI/IP
  // type, same as uuid). Other ports bind to their native URI/IP type.
  [FIELD_SUBTYPE_URI]: "string",
  [FIELD_SUBTYPE_INET]: "string",
  [FIELD_SUBTYPE_INT]: "number",
  [FIELD_SUBTYPE_LONG]: "number",
  [FIELD_SUBTYPE_DOUBLE]: "number",
  [FIELD_SUBTYPE_FLOAT]: "number",
  // field.decimal is precision-exact: Drizzle's pg `numeric` column infers as
  // `string` (the driver returns NUMERIC as a string to avoid float rounding),
  // so the value-object/structural-interface scalar mapping must match.
  [FIELD_SUBTYPE_DECIMAL]: "string",
  [FIELD_SUBTYPE_CURRENCY]: "number",
  [FIELD_SUBTYPE_BOOLEAN]: "boolean",
  [FIELD_SUBTYPE_DATE]: "string",
  [FIELD_SUBTYPE_TIME]: "string",
  [FIELD_SUBTYPE_TIMESTAMP]: "string",
};

/**
 * The PLAIN-STRING TS type expression for a field — the SINGLE source of truth
 * for "what TS type does the codegen give this field". `valueObjectFieldType`
 * (which returns a `Code` so cross-module `field.object` refs hoist via
 * `imp(...)`) makes the SAME per-branch decisions; this string form exists for
 * consumers (the api-docs field-shape builder) that need the type name as text,
 * not a hoisting `Code`. The branch logic MUST stay in lock-step with
 * `valueObjectFieldType` below.
 *
 *  • field.object → the referenced object's bare (package-stripped) name, `[]`
 *    when an array; `unknown` / `unknown[]` when the @objectRef is missing.
 *  • field.enum   → the same enum-union alias `enumUnionAliasName` emits
 *    (`<Owner><Field>` or the abstract super's PascalCase), `string` fallback.
 *  • scalar       → SCALAR_TS_BY_SUBTYPE (else `unknown`), `[]` when an array.
 */
export function fieldTsTypeString(ownerName: string, field: MetaField): string {
  // `@dbColumnType: jsonb` (open JSON bag, legal only on field.string) → `unknown`:
  // the column is a bare `jsonb()` returning any parsed JSON value, so the TS type
  // stays in lock-step with the `z.unknown()` Zod emission (NOT `string`).
  if (field.attr(FIELD_ATTR_DB_COLUMN_TYPE) === DB_COLUMN_TYPE_JSONB) {
    return field.resolvedIsArray() ? "unknown[]" : "unknown";
  }
  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    const ref = field.attr(FIELD_ATTR_OBJECT_REF);
    if (typeof ref === "string" && ref.length > 0) {
      const base = stripPackage(ref);
      return field.resolvedIsArray() ? `${base}[]` : base;
    }
    return field.resolvedIsArray() ? "unknown[]" : "unknown";
  }
  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const values = enumValues(field);
    if (values !== undefined) {
      // The emitted TS type is an enum-union ALIAS (`<Owner><Field>`), but its
      // definition IS this literal union — inline it so the documented shape is
      // self-contained (an agent sees the exact allowed values, not an opaque
      // alias name). Array enums wrap the parenthesized union: `(A | B)[]`.
      const union = enumUnionString(values);
      return field.resolvedIsArray() ? `(${union})[]` : union;
    }
    return field.resolvedIsArray() ? "string[]" : "string";
  }
  const scalar = SCALAR_TS_BY_SUBTYPE[field.subType] ?? "unknown";
  return field.resolvedIsArray() ? `${scalar}[]` : scalar;
}

/**
 * One-line TS type expression for a field on a value-only object.
 * Returns a `Code` so cross-module `field.object` refs can be hoisted via
 * ts-poet `imp(...)` — matching how the Zod emitter hoists `<Ref>InsertSchema`.
 */
function valueObjectFieldType(entity: MetaObject, field: MetaField, ctx?: RenderContext): Code {
  // `@dbColumnType: jsonb` (open JSON bag) → `unknown`, in lock-step with
  // fieldTsTypeString above and the `z.unknown()` Zod emission.
  if (field.attr(FIELD_ATTR_DB_COLUMN_TYPE) === DB_COLUMN_TYPE_JSONB) {
    return field.resolvedIsArray() ? code`unknown[]` : code`unknown`;
  }
  // field.object: import the referenced TS interface from its sibling module
  // so ts-poet hoists the import. Mirrors zod-validators.ts's `<Ref>InsertSchema`
  // import strategy, just for the type alias instead of the schema constant.
  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    const ref = field.attr(FIELD_ATTR_OBJECT_REF);
    if (typeof ref === "string" && ref.length > 0) {
      // @objectRef may be authored fully-qualified (acme::sales::Brief) or bare; the
      // referenced interface is named by the BARE short name. The import MODULE is
      // resolved through the shared layout/package/extStyle-aware helper (the SAME
      // one the Zod schema + Drizzle .$type<> use) so all three agree. Without a
      // ctx (bare unit-test calls) fall back to the flat same-dir specifier.
      const base = stripPackage(ref);
      const moduleSpec = ctx
        ? valueObjectModuleSpecifier(base, ctx.packageOf, entity.package, ctx.outputLayout, ctx.extStyle)
        : `./${base}.js`;
      const refImp = imp(`${base}@${moduleSpec}`);
      return field.resolvedIsArray() ? code`${refImp}[]` : code`${refImp}`;
    }
    return field.resolvedIsArray() ? code`unknown[]` : code`unknown`;
  }

  // field.map: Record<string, V> — V is a value-object (@objectRef) or a scalar (@valueType).
  if (field.subType === FIELD_SUBTYPE_MAP) {
    const ref = field.attr(FIELD_ATTR_OBJECT_REF);
    if (typeof ref === "string" && ref.length > 0) {
      const base = stripPackage(ref);
      const moduleSpec = ctx
        ? valueObjectModuleSpecifier(base, ctx.packageOf, entity.package, ctx.outputLayout, ctx.extStyle)
        : `./${base}.js`;
      const refImp = imp(`${base}@${moduleSpec}`);
      return code`Record<string, ${refImp}>`;
    }
    const vt = field.attr(FIELD_ATTR_VALUE_TYPE);
    const scalar = (typeof vt === "string" ? SCALAR_TS_BY_SUBTYPE[vt] : undefined) ?? "string";
    return code`Record<string, ${scalar}>`;
  }

  // field.enum: use the same type-alias name as renderEnumTypeAliases emits.
  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const values = enumValues(field);
    if (values !== undefined) {
      const alias = enumUnionAliasName(entity.name, field);
      // FR-019: a shared/provided enum's type lives in another module (./enums or
      // the provided module). Use imp() so ts-poet hoists `import { type E }` —
      // the local interface can then reference E. Inline enums reference the
      // locally-declared `<Entity><Field>` alias as before.
      if (ctx !== undefined) {
        const shared = sharedEnumForField(field);
        if (shared !== undefined) {
          const spec = shared.provided
            ? providedEnumImportSpecifier(ctx, shared.name)
            : sharedEnumImportSpecifier(ctx, entity.package);
          const sym = imp(`${shared.name}@${spec}`);
          return field.resolvedIsArray() ? code`${sym}[]` : code`${sym}`;
        }
      }
      return field.resolvedIsArray() ? code`${alias}[]` : code`${alias}`;
    }
    return field.resolvedIsArray() ? code`string[]` : code`string`;
  }

  const scalar = SCALAR_TS_BY_SUBTYPE[field.subType] ?? "unknown";
  return field.resolvedIsArray() ? code`${scalar}[]` : code`${scalar}`;
}

/**
 * Emit a structural `interface <Name> { ... }` for a value-only object.
 *
 * Optional fields use `name?: T` (matching the Zod `.optional()` inference
 * `T | undefined`) instead of `name?: T | null`. Value objects never round-
 * trip through Drizzle nullable columns, so the null-bridge is unnecessary
 * here — and forces consumers into a residual cast at the call site.
 */
export function renderValueObjectInterface(entity: MetaObject, ctx?: RenderContext): Code {
  const docs = renderDocsFor(entity);
  const docsPrefix = docs ? `${docs}\n` : "";

  const lines: Code[] = [];
  for (const field of entity.fields()) {
    const required = field.attr(FIELD_ATTR_REQUIRED) === true;
    const optional = required ? "" : "?";
    const tsType = valueObjectFieldType(entity, field, ctx);
    lines.push(code`  ${field.name}${optional}: ${tsType};`);
  }

  // joinCode with "\n" interpolates each Code segment on its own line and
  // keeps the imp() registrations intact so ts-poet hoists the imports.
  return code`${docsPrefix}export interface ${entity.name} {
${joinCode(lines, { on: "\n" })}
}
`;
}
