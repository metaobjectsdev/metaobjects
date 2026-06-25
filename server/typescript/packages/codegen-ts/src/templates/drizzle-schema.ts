// Drizzle schema template — emits a single sqliteTable() or pgTable() definition,
// with FK .references() on FK columns derived from relationship children,
// plus the relations() block auto-emitted at the end.

import { code, imp, joinCode, type Code } from "ts-poet";
import { MetaObject, MetaField, stripPackage } from "@metaobjectsdev/metadata";
import {
  IDENTITY_SUBTYPE_SECONDARY, FIELD_SUBTYPE_LONG,
  IDENTITY_ATTR_FIELDS, IDENTITY_ATTR_GENERATION, IDENTITY_ATTR_UNIQUE,
  GENERATION_INCREMENT, GENERATION_UUID,
  FIELD_ATTR_AUTO_SET,
} from "@metaobjectsdev/metadata";
import { type RenderContext } from "../render-context.js";
import { crossEntitySpecifier, valueObjectModuleSpecifier } from "../import-path.js";
import { mapColumnType, type ColumnSpec } from "../column-mapper.js";
import { tableNameFromEntity, columnNameFromField } from "../naming.js";
import { renderRelationsBlock } from "./relations-block.js";
import { renderDocsFor } from "./jsdoc.js";
import { collectTphSubtypeFields } from "./tph-discriminator.js";

/**
 * Render the Drizzle table definition for one entity, including:
 * - FK .references() on FK columns derived from relationship children
 * - relations() block at the end of the section
 *
 * Returns a Code object so ts-poet can deduplicate imports when this composes
 * with the rest of the entity file. Biome formatting runs after composition.
 */
export function renderDrizzleSchema(obj: MetaObject, ctx: RenderContext): Code {
  const dialect = ctx.dialect;
  const tableFn = dialect === "sqlite" ? "sqliteTable" : "pgTable";
  const importModule = dialect === "sqlite" ? "drizzle-orm/sqlite-core" : "drizzle-orm/pg-core";
  const tableFnSym = imp(`${tableFn}@${importModule}`);

  const tableName = obj.dbTable ?? tableNameFromEntity(obj.name, ctx.columnNamingStrategy);
  const varName = ctx.collectionName(obj.name);

  const primary = obj.primaryIdentity();
  const rawPkFields = primary?.attr(IDENTITY_ATTR_FIELDS);
  const pkFieldsList: string[] = Array.isArray(rawPkFields)
    ? rawPkFields as string[]
    : typeof rawPkFields === "string"
      ? rawPkFields.split(",").map((f) => f.trim()).filter(Boolean)
      : [];
  const pkFieldNames = new Set<string>(pkFieldsList);
  const pkGeneration = primary?.attr(IDENTITY_ATTR_GENERATION) as string | undefined;

  const fkMap = buildFkMapForEntity(obj, ctx);

  const isComposite = pkFieldNames.size > 1;

  // Collect secondary identities and the field names that need .unique() on
  // their column. Only single-column UNIQUE identities propagate .unique() to
  // the column — non-unique indexes emit a separate index() callback entry
  // (handled below) and must not stamp .unique() on the underlying column.
  const secondaryIdentities = obj.secondaryIdentities();
  const uniqueFieldNames = new Set<string>();
  for (const sec of secondaryIdentities) {
    const uniqueAttr = sec.attr(IDENTITY_ATTR_UNIQUE);
    if (uniqueAttr === false) continue; // explicit non-unique → don't mark column
    const fields = sec.attr(IDENTITY_ATTR_FIELDS) as string[] | undefined;
    if (!Array.isArray(fields) || fields.length !== 1) continue; // multi-col uniques use a callback index, not a column flag
    uniqueFieldNames.add(fields[0]!);
  }

  const columnLines: Code[] = [];
  // Collect CHECK constraints for enum columns; emitted as table-level check() callbacks.
  const checkConstraints: Array<{ name: string; expr: string }> = [];
  for (const child of obj.fields()) {
    const isPk = pkFieldNames.has(child.name);
    const isUnique = uniqueFieldNames.has(child.name) && !isPk;
    const fkInfo = fkMap.get(child.name);
    // Compute the column spec once per field and reuse it for both the column
    // line and the CHECK collection.
    const spec = mapColumnType(child, ctx.dialect, ctx.columnNamingStrategy, ctx.timestampMode);
    const fieldDocs = renderDocsFor(child);
    const columnLine = renderColumn(spec, child, ctx, isPk, pkGeneration, fkInfo, isComposite, isUnique, obj.package, obj.name);
    columnLines.push(fieldDocs ? code`  ${fieldDocs}\n${columnLine}` : columnLine);
    if (spec.checkConstraint !== undefined) {
      checkConstraints.push({
        name: `chk_${tableName}_${spec.dbName}`,
        expr: spec.checkConstraint,
      });
    }
  }

  // FR-017 Tier 2 — TPH single-table inheritance. When this entity is a
  // discriminator base, fold every concrete subtype's own columns into this
  // one table. Subtype-only columns are ALWAYS nullable (a row of any other
  // subtype stores NULL there) and never carry a DB default (a default would
  // stamp onto other-subtype inserts), regardless of the field's @required.
  // Subtype entities emit no table of their own (the value-object path).
  for (const child of collectTphSubtypeFields(obj, ctx.loadedRoot)) {
    const spec = mapColumnType(child, ctx.dialect, ctx.columnNamingStrategy, ctx.timestampMode);
    const fieldDocs = renderDocsFor(child);
    const columnLine = renderColumn(
      spec, child, ctx, false, undefined, fkMap.get(child.name), isComposite, false, obj.package, obj.name, true,
    );
    columnLines.push(fieldDocs ? code`  ${fieldDocs}\n${columnLine}` : columnLine);
    // Enum CHECK constraints stay valid under TPH: `NULL IN (...)` is NULL
    // (not false), so other-subtype rows with NULL pass the check.
    if (spec.checkConstraint !== undefined) {
      checkConstraints.push({
        name: `chk_${tableName}_${spec.dbName}`,
        expr: spec.checkConstraint,
      });
    }
  }

  // Build all table callback entries
  const callbackEntries: Code[] = [];

  if (isComposite && primary !== undefined) {
    callbackEntries.push(buildCompositeKeyCallback(pkFieldNames, importModule));
  }

  for (const sec of secondaryIdentities) {
    const fields = sec.attr(IDENTITY_ATTR_FIELDS) as string[] | undefined;
    if (!Array.isArray(fields) || fields.length === 0) continue;
    const indexName = `idx_${tableName}_${fields.map((f) => columnNameFromField(f, ctx.columnNamingStrategy)).join("_")}`;
    // @unique on the identity defaults to true (preserves back-compat with
    // foundations fixtures that assumed secondary identities were always
    // unique). Explicit @unique: false → ordinary non-unique index.
    const uniqueAttr = sec.attr(IDENTITY_ATTR_UNIQUE);
    const isUnique = uniqueAttr !== false;
    const indexFn = isUnique ? "uniqueIndex" : "index";
    const indexSym = imp(`${indexFn}@${importModule}`);
    // Use the callback param `table` (not the outer varName) so TS doesn't see
    // the table referencing itself inside its own initializer (TS7022/TS7024).
    const cols = fields.map((f) => `table.${f}`).join(", ");
    callbackEntries.push(code`${indexSym}(${JSON.stringify(indexName)}).on(${cols})`);
  }

  // Emit table-level CHECK constraints for enum fields.
  for (const { name, expr } of checkConstraints) {
    const checkSym = imp(`check@${importModule}`);
    const sqlSym = imp("sql@drizzle-orm");
    callbackEntries.push(code`${checkSym}(${JSON.stringify(name)}, ${sqlSym}\`${expr}\`)`);
  }

  let tableBlock: Code;
  if (callbackEntries.length > 0) {
    tableBlock = code`
export const ${varName} = ${tableFnSym}(${JSON.stringify(tableName)}, {
${joinCode(columnLines, { on: ",\n", trim: false })}
}, (table) => [
  ${joinCode(callbackEntries, { on: ",\n  ", trim: false })}
]);
`;
  } else {
    tableBlock = code`
export const ${varName} = ${tableFnSym}(${JSON.stringify(tableName)}, {
${joinCode(columnLines, { on: ",\n", trim: false })}
});
`;
  }

  // Emit the relations() block (returns null if no relations).
  const relationsBlock = renderRelationsBlock(obj, ctx);

  if (relationsBlock === null) {
    return tableBlock;
  }

  return joinCode([tableBlock, relationsBlock], { on: "\n" });
}

interface FkInfo {
  targetVarName: string;    // e.g., "users"
  targetEntityName: string; // e.g., "User" — used for the import path
  targetPkField: string;    // e.g., "id"
}

/** Pre-pass: map fkFieldName → FkInfo for this entity's effective (own + inherited) identity.reference children. */
function buildFkMapForEntity(obj: MetaObject, ctx: RenderContext): Map<string, FkInfo> {
  const result = new Map<string, FkInfo>();
  for (const ref of obj.referenceIdentities()) {
    // @enforce: false → logical-only reference. Skip the .references() emission;
    // the column stays plain. Drizzle's relations() block (driven by
    // relation-resolver) still includes the relationship for query navigation.
    if (!ref.enforce) continue;
    const fkFieldNames = ref.fields;
    if (fkFieldNames.length === 0) continue;
    const fkField = fkFieldNames[0]!;
    const targetName = ref.targetEntity;
    if (!targetName) continue;
    // @references may be authored bare OR package-qualified, and the loader can
    // resolve it to an FQN (e.g. the YAML front-end qualifies it). Strip the
    // package so the lookup matches the object's bare name — mirrors the
    // relation-resolver, which already does this.
    const targetObj = ctx.loadedRoot.findObject(stripPackage(targetName));
    if (!targetObj) continue;
    const targetPkField = ref.resolvedTargetPkField(ctx.loadedRoot) ?? "id";
    result.set(fkField, {
      targetVarName: ctx.collectionName(targetObj.name),
      targetEntityName: targetObj.name,
      targetPkField,
    });
  }
  return result;
}

/**
 * Build the `primaryKey({ columns: [table.f1, table.f2] })` Code expression
 * for composite primary keys. Uses imp() so ts-poet tracks the import.
 */
function buildCompositeKeyCallback(
  pkFieldNames: Set<string>,
  importModule: string,
): Code {
  const primaryKeySym = imp(`primaryKey@${importModule}`);
  const columnRefs = Array.from(pkFieldNames)
    .map((f) => `table.${f}`)
    .join(", ");
  return code`${primaryKeySym}({ columns: [${columnRefs}] })`;
}

/** Build a JS-style object literal string (not JSON.stringify which uses quoted keys).
 *  Array values get `as const` appended so Drizzle's text(...,{ enum: [...] })
 *  narrows the inferred column type to a literal union instead of bare `string`. */
function inlineObjectLiteral(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).map(([k, v]) => {
    const lit = JSON.stringify(v);
    if (Array.isArray(v)) {
      return `${k}: ${lit} as const`;
    }
    return `${k}: ${lit}`;
  });
  return `{ ${entries.join(", ")} }`;
}

/** Render one column line (field name + Drizzle column expression). */
function renderColumn(
  spec: ColumnSpec,
  field: MetaField,
  ctx: RenderContext,
  isPk: boolean,
  pkGeneration: string | undefined,
  fkInfo: FkInfo | undefined,
  isComposite: boolean,
  isUnique: boolean = false,
  entityPackage: string | undefined = undefined,
  // Name of the entity this column belongs to — used to detect a self-referential
  // FK (target entity === this entity), which Drizzle emits without a self-import.
  currentEntityName: string = "",
  // FR-017 Tier 2 — TPH subtype-only column: force nullable (drop .notNull())
  // and suppress any DB default (other-subtype rows must stay NULL here).
  forceNullable: boolean = false,
): Code {
  const fnSym = imp(`${spec.fnName}@${spec.importModule}`);

  const dbNameLit = JSON.stringify(spec.dbName);
  let baseCall: Code;
  if (spec.fnOptions !== undefined && Object.keys(spec.fnOptions).length > 0) {
    baseCall = code`${fnSym}(${dbNameLit}, ${inlineObjectLiteral(spec.fnOptions)})`;
  } else {
    baseCall = code`${fnSym}(${dbNameLit})`;
  }

  let pkSuffix = "";
  if (isPk) {
    if (pkGeneration === GENERATION_INCREMENT) {
      if (ctx.dialect === "sqlite") {
        // Composite PKs don't use .primaryKey() per-column; table callback owns it.
        pkSuffix = isComposite ? "" : ".primaryKey({ autoIncrement: true })";
      } else {
        // Postgres: bigserial for long (8-byte), serial for int (4-byte).
        if (field.subType === FIELD_SUBTYPE_LONG) {
          const bigserialSym = imp(`bigserial@${spec.importModule}`);
          baseCall = code`${bigserialSym}(${dbNameLit}, { mode: "number" })`;
        } else {
          const serialSym = imp(`serial@${spec.importModule}`);
          baseCall = code`${serialSym}(${dbNameLit})`;
        }
        pkSuffix = isComposite ? "" : ".primaryKey()";
      }
    } else if (pkGeneration === GENERATION_UUID) {
      pkSuffix = isComposite
        ? ""
        : ctx.dialect === "sqlite"
          ? ".primaryKey().$defaultFn(() => crypto.randomUUID())"
          : ".primaryKey().defaultRandom()";
    } else {
      // No generation: natural PK. Composite hands off to table callback.
      pkSuffix = isComposite ? "" : ".primaryKey()";
    }
  }

  let modifiersStr = pkSuffix;
  // Append .unique() for secondary-identity fields (isPk guard already excluded PKs upstream).
  if (isUnique) modifiersStr += ".unique()";
  for (const m of spec.modifiers) {
    // Single-column PKs imply notNull/unique; avoid emitting them twice.
    // Composite-PK columns are NOT declared with .primaryKey(), so they DO need .notNull().
    if (isPk && !isComposite && (m === ".notNull()" || m === ".unique()")) continue;
    // Avoid double-emitting .unique() if it was already appended above.
    if (isUnique && m === ".unique()") continue;
    // TPH subtype-only column: never .notNull() / .unique() — rows of other
    // subtypes store NULL, so neither constraint can hold across the table.
    if (forceNullable && (m === ".notNull()" || m === ".unique()")) continue;
    modifiersStr += m;
  }

  // sqlDefaultSegment must be a Code segment (not a raw string) so ts-poet tracks
  // the `sql` import via imp(); a raw `.default(sql`...`)` would leave `sql`
  // unresolved in the generated file.
  let sqlDefaultSegment: Code | null = null;
  if (spec.defaultExpr !== undefined && !isPk && !forceNullable) {
    if (spec.defaultExpr.kind === "now") {
      if (ctx.dialect === "sqlite") {
        const sqlSym = imp("sql@drizzle-orm");
        sqlDefaultSegment = code`.default(${sqlSym}\`CURRENT_TIMESTAMP\`)`;
      } else {
        modifiersStr += `.defaultNow()`;
      }
    } else if (spec.defaultExpr.kind === "sqlExpr") {
      const sqlSym = imp("sql@drizzle-orm");
      // Raw SQL keyword/expression — emit as sql`<raw>` for both dialects.
      sqlDefaultSegment = code`.default(${sqlSym}\`${spec.defaultExpr.raw}\`)`;
    } else {
      // literal
      modifiersStr += `.default(${JSON.stringify(spec.defaultExpr.value)})`;
    }
  }

  // FK .references() uses imp() so ts-poet tracks the cross-entity import.
  let fkRefSegment: Code | null = null;
  if (fkInfo !== undefined && !isPk) {
    // Always annotate the .references() callback with the dialect's Any*Column return
    // type. Drizzle needs this to break circular type inference — not only for
    // self-referential FKs but also for cross-module circular references (table A → B
    // while B → A), which otherwise surface as TS7022 ("implicitly has type 'any'
    // because it does not have a type annotation and is referenced … in its own
    // initializer") under `strict`. The annotation is a harmless explicit supertype
    // for acyclic FKs, so emitting it unconditionally is safe.
    const anyColType = ctx.dialect === "sqlite" ? "AnySQLiteColumn" : "AnyPgColumn";
    const anyColSym = imp(`${anyColType}@${spec.importModule}`);
    if (fkInfo.targetEntityName === currentEntityName) {
      // Self-referential FK (e.g. createdBy → this same table): reference the local
      // table const directly — NOT a self-import.
      fkRefSegment = code`.references((): ${anyColSym} => ${fkInfo.targetVarName}.${fkInfo.targetPkField})`;
    } else {
      const targetSpec = crossEntitySpecifier(
        ctx.outputLayout,
        entityPackage,
        ctx.packageOf.get(fkInfo.targetEntityName),
        fkInfo.targetEntityName,
        ctx.extStyle,
      );
      const targetVarSym = imp(`${fkInfo.targetVarName}@${targetSpec}`);
      fkRefSegment = code`.references((): ${anyColSym} => ${targetVarSym}.${fkInfo.targetPkField})`;
    }
  }

  // @autoSet fields: emit .$defaultFn(() => new Date().toISOString()) so Drizzle
  // inserts stamp the server-side timestamp automatically. This means callers don't
  // need to supply createdAt / updatedAt in INSERT calls — Drizzle fills them in.
  const autoSet = field.attr(FIELD_ATTR_AUTO_SET);
  const autoSetSuffix = (autoSet === "onCreate" || autoSet === "onUpdate")
    ? `.$defaultFn(() => new Date().toISOString())`
    : "";

  // $type<E[]>() chain — emitted as Code (not a string modifier) so ts-poet can
  // hoist the cross-module type import for objectRef variants. Positioned
  // immediately after the baseCall so the chain reads `.text(...).$type<...>().notNull()...`
  // which Drizzle accepts in any order but is conventional for "type narrowing
  // first."
  // Resolve a VO name → an imported type symbol (shared layout/package/extStyle-aware
  // helper, so the .$type<VO> import matches the field's TS type + Zod schema).
  const voSym = (name: string) =>
    imp(`${name}@${valueObjectModuleSpecifier(name, ctx.packageOf, entityPackage, ctx.outputLayout, ctx.extStyle)}`);

  let dollarTypeSegment: Code | string = "";
  if (spec.dollarTypeRef !== undefined) {
    const ref = spec.dollarTypeRef;
    if (ref.kind === "scalar") {
      dollarTypeSegment = `.$type<${ref.tsType}${ref.array ? "[]" : ""}>()`;
    } else if (ref.kind === "objectRef") {
      const refSym = voSym(ref.name);
      dollarTypeSegment = ref.array ? code`.$type<${refSym}[]>()` : code`.$type<${refSym}>()`;
    } else {
      // field.map → Record<string, V>; V is a scalar or a hoisted value-object.
      dollarTypeSegment = "scalar" in ref.value
        ? `.$type<Record<string, ${ref.value.scalar}>>()`
        : code`.$type<Record<string, ${voSym(ref.value.objectRef)}>>()`;
    }
  }

  const columnLine = code`  ${field.name}: ${baseCall}${dollarTypeSegment}${modifiersStr}${autoSetSuffix}${sqlDefaultSegment ?? ""}${fkRefSegment ?? ""}`;
  return spec.leadingComment !== undefined
    ? code`  // ${spec.leadingComment}\n${columnLine}`
    : columnLine;
}
