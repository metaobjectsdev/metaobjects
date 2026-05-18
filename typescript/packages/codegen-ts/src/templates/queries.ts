// Queries template — individual CRUD function renderers.
// Each returns a ts-poet Code block; composed into a file by queries-file.ts.

import { code, imp, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjects/metadata";
import { IDENTITY_ATTR_FIELDS } from "@metaobjects/metadata";
import type { RenderContext } from "../render-context.js";
import { variableNameFromEntity, toSnakeCase, pluralize } from "../naming.js";

/** Derive a stable prepared statement name. Deterministic from entity + field names. */
function prepareName(prefix: string, entitySnakeName: string, fieldDbName: string): string {
  return `${prefix}_${entitySnakeName}_by_${fieldDbName}`;
}

/** Get the PK field name and its TS type for a given entity. */
function getPkInfo(entity: MetaObject, ctx: RenderContext): { fieldName: string; tsType: string } {
  // Use primaryIdentity() to find the primary identity (may be inherited from extends:/super:).
  const primary = entity.primaryIdentity();
  const rawFields = primary?.attr(IDENTITY_ATTR_FIELDS);
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
  const entitySnakeName = toSnakeCase(entityName);
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  const pkSnakeName = toSnakeCase(pkField);
  const prepName = prepareName("find", entitySnakeName, pkSnakeName);
  const fnName = `find${entityName}ById`;
  const prepVarName = `${fnName}Prepared`;
  const eqSym = imp("eq@drizzle-orm");
  const sqlSym = imp("sql@drizzle-orm");

  const baseVarName = `${fnName}Base`;

  // Drizzle's `.prepare()` signature differs by dialect:
  //   - Postgres: prepare(name) — the name is used by the pg driver to cache the plan
  //   - SQLite:   prepare()     — no name; the name arg was removed in drizzle-orm 0.41+
  const prepArg = ctx.dialect === "postgres" ? `"${prepName}"` : "";

  return code`
const ${baseVarName} = db
  .select()
  .from(${varName})
  .where(${eqSym}(${varName}.${pkField}, ${sqlSym}.placeholder(${JSON.stringify(pkField)})));
const ${prepVarName} = ${baseVarName}.prepare(${prepArg});

export async function ${fnName}(${pkField}: ${pkType}): Promise<${entityName} | null> {
  const [${singularVar}] = await ${prepVarName}.execute({ ${pkField} });
  return ${singularVar} ?? null;
}
`;
}

export function renderListFn(entity: MetaObject, _ctx: RenderContext): Code {
  const varName = variableNameFromEntity(entity.name);
  const entityName = entity.name;
  // Pluralize the PascalCase entity name, preserving capitalization
  // (e.g., "Category" -> "Categories", not "Categorys").
  const fnName = `list${pluralize(entityName)}`;

  return code`
export async function ${fnName}(opts?: { limit?: number; offset?: number }): Promise<${entityName}[]> {
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
  const fnName = `create${entityName}`;
  const schemaName = `${entityName}InsertSchema`;

  return code`
export async function ${fnName}(data: unknown): Promise<${entityName}> {
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
  const fnName = `update${entityName}`;
  const schemaName = `${entityName}InsertSchema`;
  const eqSym = imp("eq@drizzle-orm");

  return code`
export async function ${fnName}(${pkField}: ${pkType}, data: unknown): Promise<${entityName} | null> {
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
  const fnName = `delete${entityName}ById`;
  const eqSym = imp("eq@drizzle-orm");

  return code`
export async function ${fnName}(${pkField}: ${pkType}): Promise<boolean> {
  const result = await db.delete(${varName}).where(${eqSym}(${varName}.${pkField}, ${pkField}));
  // SQLite (libsql/Turso) returns { rowsAffected }; postgres returns array from .returning()
  return ('rowsAffected' in result ? result.rowsAffected : (result as unknown as unknown[]).length) > 0;
}
`;
}
