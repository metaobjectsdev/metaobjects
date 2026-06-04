// Queries template — individual CRUD function renderers.
// Each returns a ts-poet Code block; composed into a file by queries-file.ts.

import { code, imp, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { IDENTITY_ATTR_FIELDS } from "@metaobjectsdev/metadata";
import type { RenderContext } from "../render-context.js";
import {
  variableNameFromEntity,
  pluralize,
  findByIdFnName,
  listFnName,
  createFnName,
  updateFnName,
  deleteByIdFnName,
} from "../naming.js";

/** Get the PK field name and its TS type for a given entity. */
export function getPkInfo(entity: MetaObject, ctx: RenderContext): { fieldName: string; tsType: string } {
  // Use primaryIdentity() to find the primary identity (may be inherited from extends:/super:).
  const primary = entity.primaryIdentity();
  const rawFields = primary?.ownAttr(IDENTITY_ATTR_FIELDS);
  const fields = Array.isArray(rawFields) ? rawFields : (typeof rawFields === "string" ? [rawFields] : undefined);
  const pkFieldName = fields?.[0] ?? "id";
  const pkInfo = ctx.pkMap.get(entity.name);
  const subType = pkInfo?.fieldSubType ?? "long";
  const tsType =
    subType === "long" || subType === "int" || subType === "short" || subType === "byte"
      ? "number"
      : subType === "boolean"
        ? "boolean"
        : "string";
  return { fieldName: pkFieldName, tsType };
}

export function renderFindByIdFn(entity: MetaObject, ctx: RenderContext): Code {
  const varName = variableNameFromEntity(entity.name);
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

export function renderListFn(entity: MetaObject, _ctx: RenderContext): Code {
  const varName = variableNameFromEntity(entity.name);
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

export function renderCreateFn(entity: MetaObject, _ctx: RenderContext): Code {
  const varName = variableNameFromEntity(entity.name);
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
  const varName = variableNameFromEntity(entity.name);
  const entityName = entity.name;
  const singularVar = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  const fnName = updateFnName(entityName);
  const schemaName = `${entityName}InsertSchema`;
  const eqSym = imp("eq@drizzle-orm");

  return code`
export async function ${fnName}(db: Db, ${pkField}: ${pkType}, data: unknown): Promise<${entityName} | null> {
  const validated = ${schemaName}.partial().parse(data);
  const [${singularVar}] = await db.update(${varName}).set(validated).where(${eqSym}(${varName}.${pkField}, ${pkField})).returning();
  return ${singularVar} ?? null;
}
`;
}

export function renderDeleteByIdFn(entity: MetaObject, ctx: RenderContext): Code {
  const varName = variableNameFromEntity(entity.name);
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
