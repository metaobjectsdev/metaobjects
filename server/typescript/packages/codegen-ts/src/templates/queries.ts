// Queries template — individual CRUD function renderers.
// Each returns a ts-poet Code block; composed into a file by queries-file.ts.

import { code, imp, type Code } from "ts-poet";
import {
  type MetaObject,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  isMetaObject,
  refTarget,
  stripPackage,
} from "@metaobjectsdev/metadata";
import type { RenderContext } from "../render-context.js";
import { getPkInfo, pkInfoOf, subTypeToTsType } from "../pk-resolver.js";
import { supportsReturning } from "../dialect-module.js";
import {
  findByIdFnName,
  listFnName,
  createFnName,
  insertPreservingFnName,
  updateFnName,
  deleteByIdFnName,
  reverseFinderFnName,
  reverseFinderInFnName,
  singleRowVarName,
} from "../naming.js";

// #214 — a write-through entity read-view routes READS to its replica view; the read
// renderers below accept an optional `readVar` (the collection to SELECT from). Absent,
// they read the entity's own table (the vanilla path, byte-identical). Writes always
// target the table, so create/update/delete take no such override.
export function renderFindByIdFn(entity: MetaObject, ctx: RenderContext, readVar?: string): Code {
  const varName = readVar ?? ctx.collectionName(entity.name);
  const entityName = entity.name;
  const singularVar = singleRowVarName(entityName, varName);
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

export function renderListFn(entity: MetaObject, ctx: RenderContext, readVar?: string): Code {
  const varName = readVar ?? ctx.collectionName(entity.name);
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

/**
 * `z.input<typeof <schema>>` — a write function's typed input, spelled through the schema it
 * parses with. NOT through the entity module's `<Entity>Create` / `<Entity>CreatePreserving`
 * aliases: this primitive's output lands in whatever file an OWNED queries generator
 * composes, and the names in scope there are the ones that owned copy's import line brings
 * in. A copy ejected before 1.0.9 imports `<Entity>InsertSchema` (every version does) but not
 * the aliases, so `data: <Entity>Create` was TS2304 "Cannot find name" in every queries
 * module of an adopter who upgraded. `z` is hoisted here as a type-only import.
 */
export function schemaInputType(schema: string | Code | ReturnType<typeof imp>): Code {
  return code`${imp("t:z@zod")}.input<typeof ${schema}>`;
}

/**
 * The INSERT body for a dialect without `RETURNING` (MySQL): insert, take the key from the
 * validated row (an assigned key) or from `$returningId()` (an AUTO_INCREMENT or
 * `$defaultFn` key), and read the row back by it.
 */
function insertThenReadBack(entity: MetaObject, ctx: RenderContext, varName: string): string {
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  const findByIdFn = findByIdFnName(entity.name);
  return `  const [inserted] = await db.insert(${varName}).values(validated).$returningId();
  const key = (validated as { ${pkField}?: ${pkType} }).${pkField} ?? (inserted as { ${pkField}?: ${pkType} } | undefined)?.${pkField};
  if (key === undefined) throw new Error("${entity.name}: the insert produced no ${pkField}");
  return (await ${findByIdFn}(db, key))!;`;
}

export function renderCreateFn(entity: MetaObject, ctx: RenderContext): Code {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  const singularVar = singleRowVarName(entityName, varName);
  const fnName = createFnName(entityName);
  const schemaName = `${entityName}InsertSchema`;

  // Typed with the insert schema's INPUT type (what the entity module exports as
  // `<Entity>Create`) so a renamed/misspelt field is a compile error at the call site, as
  // `<Entity>Patch` is for update. The schema still parses at runtime (a caller holding
  // `unknown` casts). Spelled via the schema, not the alias — see schemaInputType.
  if (!supportsReturning(ctx.dialect)) {
    return code`
export async function ${fnName}(db: Db, data: ${schemaInputType(schemaName)}): Promise<${entityName}> {
  const validated = ${schemaName}.parse(data);
${insertThenReadBack(entity, ctx, varName)}
}
`;
  }
  return code`
export async function ${fnName}(db: Db, data: ${schemaInputType(schemaName)}): Promise<${entityName}> {
  const validated = ${schemaName}.parse(data);
  const [${singularVar}] = await db.insert(${varName}).values(validated).returning();
  return ${singularVar}!;
}
`;
}

/**
 * #203 — the `insertPreserving<Entity>` escape hatch. Cross-port with the Java /
 * Kotlin / C# / Python ports: emitted ONLY for an entity that declares @autoSet
 * fields, it persists the row WITHOUT the create-time now() stamp — the @autoSet
 * columns are written verbatim from the caller's data — for import / restore /
 * replication paths that must keep the original timestamps. It validates through
 * `<Entity>InsertPreservingSchema` (the preserving-shape schema whose @autoSet
 * columns carry no transform); the normal `create<Entity>` always stamps now().
 */
export function renderInsertPreservingFn(entity: MetaObject, ctx: RenderContext): Code {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  const singularVar = singleRowVarName(entityName, varName);
  const fnName = insertPreservingFnName(entityName);
  const schemaName = `${entityName}InsertPreservingSchema`;

  if (!supportsReturning(ctx.dialect)) {
    return code`
export async function ${fnName}(db: Db, data: ${schemaInputType(schemaName)}): Promise<${entityName}> {
  const validated = ${schemaName}.parse(data);
${insertThenReadBack(entity, ctx, varName)}
}
`;
  }
  return code`
export async function ${fnName}(db: Db, data: ${schemaInputType(schemaName)}): Promise<${entityName}> {
  const validated = ${schemaName}.parse(data);
  const [${singularVar}] = await db.insert(${varName}).values(validated).returning();
  return ${singularVar}!;
}
`;
}

export function renderUpdateFn(entity: MetaObject, ctx: RenderContext): Code {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  const singularVar = singleRowVarName(entityName, varName);
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  const fnName = updateFnName(entityName);
  const findByIdFn = findByIdFnName(entityName);
  // PATCH contract (FR-035): validate the caller's assignments against the
  // UPDATE schema (all-optional; PK, @mutability readOnly AND writeOnce excluded; no insert-time transforms
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
  ${supportsReturning(ctx.dialect)
    ? code`const [${singularVar}] = await db.update(${varName}).set(validated).where(${eqSym}(${varName}.${pkField}, ${pkField})).returning();
  return ${singularVar} ?? null;`
    : code`// No RETURNING on this dialect: update, then read the row back (null when absent).
  await db.update(${varName}).set(validated).where(${eqSym}(${varName}.${pkField}, ${pkField}));
  return ${findByIdFn}(db, ${pkField});`}
}
`;
}

export function renderDeleteByIdFn(entity: MetaObject, ctx: RenderContext): Code {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  const fnName = deleteByIdFnName(entityName);
  const eqSym = imp("eq@drizzle-orm");

  if (!supportsReturning(ctx.dialect)) {
    const findByIdFn = findByIdFnName(entityName);
    return code`
export async function ${fnName}(db: Db, ${pkField}: ${pkType}): Promise<boolean> {
  // No RETURNING on this dialect, and the affected-row count's shape is driver-specific:
  // report whether the row existed, then delete it.
  if ((await ${findByIdFn}(db, ${pkField})) === null) return false;
  await db.delete(${varName}).where(${eqSym}(${varName}.${pkField}, ${pkField}));
  return true;
}
`;
  }
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
  /** Target entity name (the `T` referenced), e.g. `Scene`. An identifier, never a lookup key. */
  targetEntity: string;
  /** The entity `@references` binds to (ADR-0059 R7). Its PK type drives the value TS type. */
  target?: MetaObject | undefined;
}

/** Collect this entity's OWN reverse FK targets, in declaration order. */
export function reverseFksFor(entity: MetaObject): ReverseFk[] {
  const out: ReverseFk[] = [];
  for (const ref of entity.referenceIdentities()) {
    const fkField = ref.fields[0];
    const targetRef = ref.targetEntity;
    if (!fkField || !targetRef) continue;
    const bound = refTarget(ref, IDENTITY_REFERENCE_ATTR_REFERENCES);
    const target = isMetaObject(bound) ? bound : undefined;
    out.push({ fkField, targetEntity: target?.name ?? stripPackage(targetRef), target });
  }
  return out;
}

/** Render the single + batched reverse finders for one FK on `entity`. `readVar`
 *  (#214) routes the SELECT to a write-through entity's replica view; absent, it
 *  reads the entity's own table (vanilla, byte-identical). */
export function renderReverseFinderFns(entity: MetaObject, fk: ReverseFk, ctx: RenderContext, readVar?: string): Code {
  const varName = readVar ?? ctx.collectionName(entity.name);
  const entityName = entity.name;
  // The Drizzle table object is keyed by the LOGICAL field name (the DB column
  // name is the argument to integer()/text()), so column access uses fk.fkField.
  // The FK value type is the target entity's PK type (the FK references it). Fall
  // back to the FK field's own subType, then to number (long-shaped key default).
  const targetPk = fk.target === undefined ? undefined : pkInfoOf(fk.target);
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
