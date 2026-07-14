// Queries template — individual CRUD function renderers.
// Each returns a ts-poet Code block; composed into a file by queries-file.ts.

import { code, imp, type Code } from "ts-poet";
import { type MetaObject, stripPackage } from "@metaobjectsdev/metadata";
import { IDENTITY_ATTR_FIELDS } from "@metaobjectsdev/metadata";
import type { RenderContext } from "../render-context.js";
import {
  findByIdFnName,
  listFnName,
  createFnName,
  updateFnName,
  deleteByIdFnName,
  reverseFinderFnName,
  reverseFinderInFnName,
} from "../naming.js";

/** Map a field subType to the generated TS scalar type for keys/values. */
function subTypeToTsType(subType: string): "number" | "boolean" | "string" {
  return subType === "long" || subType === "int" || subType === "short" || subType === "byte"
    ? "number"
    : subType === "boolean"
      ? "boolean"
      : "string";
}

/** Get the PK field name and its TS type for a given entity. */
export function getPkInfo(entity: MetaObject, ctx: RenderContext): { fieldName: string; tsType: string } {
  // Use primaryIdentity() to find the primary identity (may be inherited from extends:/super:).
  const primary = entity.primaryIdentity();
  const rawFields = primary?.attr(IDENTITY_ATTR_FIELDS);
  const fields = Array.isArray(rawFields) ? rawFields : (typeof rawFields === "string" ? [rawFields] : undefined);
  const pkFieldName = fields?.[0] ?? "id";
  const pkInfo = ctx.pkMap.get(entity.name);
  const subType = pkInfo?.fieldSubType ?? "long";
  return { fieldName: pkFieldName, tsType: subTypeToTsType(subType) };
}

export function renderFindByIdFn(entity: MetaObject, ctx: RenderContext): Code {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  const singularVar = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  const fnName = findByIdFnName(entityName);
  const eqSym = imp("eq@drizzle-orm");

  return code`
export async function ${fnName}(db: Db, ${pkField}: ${pkType}): Promise<${entityName} | null> {
  const [${singularVar}] = await db.select().from(${varName}).where(${eqSym}(${varName}.${pkField}, ${pkField})).limit(1);
  return ${singularVar} ?? null;
}
`;
}

export function renderListFn(entity: MetaObject, ctx: RenderContext): Code {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  // Pluralize the PascalCase entity name, preserving capitalization
  // (e.g., "Category" -> "Categories", not "Categorys").
  const fnName = listFnName(entityName);

  return code`
export async function ${fnName}(db: Db, opts?: { limit?: number; offset?: number }): Promise<${entityName}[]> {
  let q = db.select().from(${varName}).$dynamic();
  if (opts?.limit !== undefined) q = q.limit(opts.limit);
  if (opts?.offset !== undefined) q = q.offset(opts.offset);
  return q;
}
`;
}

export function renderCreateFn(entity: MetaObject, ctx: RenderContext): Code {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  const singularVar = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const fnName = createFnName(entityName);
  const schemaName = `${entityName}InsertSchema`;

  return code`
export async function ${fnName}(db: Db, data: unknown): Promise<${entityName}> {
  const validated = ${schemaName}.parse(data);
  const [${singularVar}] = await db.insert(${varName}).values(validated).returning();
  return ${singularVar}!;
}
`;
}

export function renderUpdateFn(entity: MetaObject, ctx: RenderContext): Code {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  const singularVar = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  const fnName = updateFnName(entityName);
  const findByIdFn = findByIdFnName(entityName);
  // PATCH contract (FR-035): validate the caller's assignments against the
  // UPDATE schema (all-optional, PK/@readOnly excluded, no insert-time transforms
  // like @autoSet-onCreate → now() or the InsertSchema's discriminator handling)
  // — NOT `InsertSchema.partial()`. The typed `<Entity>Patch` param makes a
  // renamed/dropped field a compile error at every call site (PATCH-1..4);
  // `.set()` writes ONLY the assigned columns, so an omitted field is untouched.
  const updateSchemaName = `${entityName}UpdateSchema`;
  const patchType = `${entityName}Patch`;
  const eqSym = imp("eq@drizzle-orm");

  return code`
export async function ${fnName}(db: Db, ${pkField}: ${pkType}, patch: ${patchType}): Promise<${entityName} | null> {
  const validated = ${updateSchemaName}.parse(patch);
  // PATCH-5: an empty patch is a no-op — return the current row rather than let
  // Drizzle throw on an empty SET clause.
  if (Object.keys(validated).length === 0) return ${findByIdFn}(db, ${pkField});
  const [${singularVar}] = await db.update(${varName}).set(validated).where(${eqSym}(${varName}.${pkField}, ${pkField})).returning();
  return ${singularVar} ?? null;
}
`;
}

export function renderDeleteByIdFn(entity: MetaObject, ctx: RenderContext): Code {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  const fnName = deleteByIdFnName(entityName);
  const eqSym = imp("eq@drizzle-orm");

  return code`
export async function ${fnName}(db: Db, ${pkField}: ${pkType}): Promise<boolean> {
  // Use .returning() unconditionally — supported on SQLite ≥3.35 (covers D1, libsql/Turso)
  // and Postgres. Result is an array of deleted rows; presence implies success.
  const deleted = await db.delete(${varName}).where(${eqSym}(${varName}.${pkField}, ${pkField})).returning();
  return deleted.length > 0;
}
`;
}

/**
 * One reverse FK finder pair (ADR-0038): the entity holding this FK (`E`) gains
 * `find<EPlural>By<FkField>(value)` (single, `WHERE fk = ?`) and
 * `find<EPlural>By<FkField>In(values)` (batched, `WHERE fk IN (…)`, anti-N+1) so
 * the referenced entity `T` can navigate to its referencing `E` rows by calling
 * the finder with a `T` id. Both are plain, framework-free, single-query reads.
 */
interface ReverseFk {
  /** FK FIELD name on this entity (logical), e.g. `currentSceneId`. */
  fkField: string;
  /** Target entity (the `T` referenced), e.g. `Scene`. Drives the value TS type. */
  targetEntity: string;
}

/** Collect this entity's OWN reverse FK targets, in declaration order. */
export function reverseFksFor(entity: MetaObject): ReverseFk[] {
  const out: ReverseFk[] = [];
  for (const ref of entity.referenceIdentities()) {
    const fkField = ref.fields[0];
    const target = ref.targetEntity;
    if (!fkField || !target) continue;
    out.push({ fkField, targetEntity: stripPackage(target) });
  }
  return out;
}

/** Render the single + batched reverse finders for one FK on `entity`. */
export function renderReverseFinderFns(entity: MetaObject, fk: ReverseFk, ctx: RenderContext): Code {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  // The Drizzle table object is keyed by the LOGICAL field name (the DB column
  // name is the argument to integer()/text()), so column access uses fk.fkField.
  // The FK value type is the target entity's PK type (the FK references it). Fall
  // back to the FK field's own subType, then to number (long-shaped key default).
  const targetPk = ctx.pkMap.get(fk.targetEntity);
  const ownField = entity.findField(fk.fkField);
  const valueType = subTypeToTsType(targetPk?.fieldSubType ?? ownField?.subType ?? "long");

  const singleName = reverseFinderFnName(entityName, fk.fkField);
  const batchName = reverseFinderInFnName(entityName, fk.fkField);
  const eqSym = imp("eq@drizzle-orm");
  const inArraySym = imp("inArray@drizzle-orm");

  return code`
export async function ${singleName}(db: Db, ${fk.fkField}: ${valueType}): Promise<${entityName}[]> {
  return db.select().from(${varName}).where(${eqSym}(${varName}.${fk.fkField}, ${fk.fkField}));
}

export async function ${batchName}(db: Db, ${fk.fkField}s: ${valueType}[]): Promise<${entityName}[]> {
  if (${fk.fkField}s.length === 0) return [];
  return db.select().from(${varName}).where(${inArraySym}(${varName}.${fk.fkField}, ${fk.fkField}s));
}
`;
}
