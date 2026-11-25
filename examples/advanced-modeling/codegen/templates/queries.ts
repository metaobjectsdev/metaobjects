// Queries template — individual CRUD function writers, laid out by the code writer (ADR-0063).
// Each writes one function into a TsWriter; composed into a file by queries-file.ts.

import {
  type MetaObject,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  isMetaObject,
  refTarget,
  stripPackage,
} from "@metaobjectsdev/metadata";
import type { RenderContext } from "@metaobjectsdev/codegen-ts/engine";
import { getPkInfo, pkInfoOf, subTypeToTsType } from "@metaobjectsdev/codegen-ts/engine";
import { supportsReturning } from "@metaobjectsdev/codegen-ts/engine";
import { flatKeyOfPath } from "@metaobjectsdev/codegen-ts/engine";
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
} from "@metaobjectsdev/codegen-ts/engine";
import { code, imp, type Code } from "@metaobjectsdev/codegen-ts/engine";
import { TsWriter } from "@metaobjectsdev/codegen-ts/engine";

// #214 — a write-through entity read-view routes READS to its replica view; the read
// renderers below accept an optional `readVar` (the collection to SELECT from). Absent,
// they read the entity's own table (the vanilla path, byte-identical). Writes always
// target the table, so create/update/delete take no such override.
// #214 — a write-through entity read-view routes READS to its replica view; the read
// writers below accept an optional `readVar` (the collection to SELECT from). Absent,
// they read the entity's own table (the vanilla path). Writes always target the table,
// so create/update/delete take no such override.
export function writeFindByIdFn(w: TsWriter, entity: MetaObject, ctx: RenderContext, readVar?: string): void {
  const varName = readVar ?? ctx.collectionName(entity.name);
  const entityName = entity.name;
  const singularVar = singleRowVarName(entityName, varName);
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  const eq = w.use("eq", "drizzle-orm");
  w.block(`export async function ${findByIdFnName(entityName)}(db: Db, ${pkField}: ${pkType}): Promise<${entityName} | null> {`, () => {
    w.line(`const [${singularVar}] = await db.select().from(${varName}).where(${eq}(${varName}.${pkField}, ${pkField})).limit(1);`);
    w.line(`return ${singularVar} ?? null;`);
  });
}

export function writeListFn(w: TsWriter, entity: MetaObject, ctx: RenderContext, readVar?: string): void {
  const varName = readVar ?? ctx.collectionName(entity.name);
  // Pluralize the PascalCase entity name, preserving capitalization
  // (e.g., "Category" -> "Categories", not "Categorys").
  w.block(`export async function ${listFnName(entity)}(db: Db, opts?: { limit?: number; offset?: number }): Promise<${entity.name}[]> {`, () => {
    writePagedSelect(w, `db.select().from(${varName}).$dynamic()`);
    w.line("return q;");
  });
}

/** `if (<cond>) { <stmt> }` — every generated `if` carries braces, even a one-statement one. */
export function writeIf(w: TsWriter, cond: string, stmt: string): void {
  w.block(`if (${cond}) {`, () => w.line(stmt));
}

/** `let q = <select>;` then the optional `limit` / `offset`, the head of every list function. */
export function writePagedSelect(w: TsWriter, select: string): void {
  w.line(`let q = ${select};`);
  writeIf(w, "opts?.limit !== undefined", "q = q.limit(opts.limit);");
  writeIf(w, "opts?.offset !== undefined", "q = q.offset(opts.offset);");
}

/**
 * `z.input<typeof <schema>>` — a write function's typed input, spelled through the schema it
 * parses with. NOT through the entity module's `<Entity>Create` / `<Entity>CreatePreserving`
 * aliases: this primitive's output lands in whatever file an OWNED queries generator
 * composes, and the names in scope there are the ones that owned copy's import line brings
 * in. A copy ejected before 1.0.9 imports `<Entity>InsertSchema` (every version does) but not
 * the aliases, so `data: <Entity>Create` was TS2304 "Cannot find name" in every queries
 * module of an adopter who upgraded. `z` is recorded here as a type-only import.
 */
export function useSchemaInputType(w: TsWriter, schema: string): string {
  return `${w.useType("z", "zod")}.input<typeof ${schema}>`;
}

/**
 * The INSERT body for a dialect without `RETURNING` (MySQL): insert, take the key from the
 * validated row (an assigned key) or from `$returningId()` (an AUTO_INCREMENT or
 * `$defaultFn` key), and read the row back by it.
 */
function writeInsertThenReadBack(w: TsWriter, entity: MetaObject, ctx: RenderContext, varName: string): void {
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  w.line(`const [inserted] = await db.insert(${varName}).values(validated).$returningId();`);
  w.line(`const key = (validated as { ${pkField}?: ${pkType} }).${pkField} ?? (inserted as { ${pkField}?: ${pkType} } | undefined)?.${pkField};`);
  writeIf(w, "key === undefined", `throw new Error("${entity.name}: the insert produced no ${pkField}");`);
  w.line(`return (await ${findByIdFnName(entity.name)}(db, key))!;`);
}

/** A create function over `schemaName`: parse, insert, return the row (read back where there is no `RETURNING`). */
function writeInsertFn(w: TsWriter, entity: MetaObject, ctx: RenderContext, fnName: string, schemaName: string): void {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  // Typed with the insert schema's INPUT type (what the entity module exports as
  // `<Entity>Create`) so a renamed/misspelt field is a compile error at the call site, as
  // `<Entity>Patch` is for update. The schema still parses at runtime (a caller holding
  // `unknown` casts). Spelled via the schema, not the alias — see useSchemaInputType.
  w.block(`export async function ${fnName}(db: Db, data: ${useSchemaInputType(w, schemaName)}): Promise<${entityName}> {`, () => {
    w.line(`const validated = ${schemaName}.parse(data);`);
    if (!supportsReturning(ctx.dialect)) {
      writeInsertThenReadBack(w, entity, ctx, varName);
      return;
    }
    const singularVar = singleRowVarName(entityName, varName);
    w.line(`const [${singularVar}] = await db.insert(${varName}).values(validated).returning();`);
    w.line(`return ${singularVar}!;`);
  });
}

export function writeCreateFn(w: TsWriter, entity: MetaObject, ctx: RenderContext): void {
  writeInsertFn(w, entity, ctx, createFnName(entity.name), `${entity.name}InsertSchema`);
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
export function writeInsertPreservingFn(w: TsWriter, entity: MetaObject, ctx: RenderContext): void {
  writeInsertFn(w, entity, ctx, insertPreservingFnName(entity.name), `${entity.name}InsertPreservingSchema`);
}

export function writeUpdateFn(w: TsWriter, entity: MetaObject, ctx: RenderContext): void {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  const singularVar = singleRowVarName(entityName, varName);
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  const findByIdFn = findByIdFnName(entityName);
  // PATCH contract (FR-035): validate the caller's assignments against the
  // UPDATE schema (all-optional; PK, @mutability readOnly AND writeOnce excluded; no insert-time transforms
  // like @autoSet-onCreate → now() or the InsertSchema's discriminator handling)
  // — NOT `InsertSchema.partial()`. The typed `<Entity>Patch` param makes a
  // renamed/dropped field a compile error at every call site (PATCH-1..4);
  // `.set()` writes ONLY the assigned columns, so an omitted field is untouched.
  const eq = w.use("eq", "drizzle-orm");
  const where = `.where(${eq}(${varName}.${pkField}, ${pkField}))`;
  w.block(`export async function ${updateFnName(entityName)}(db: Db, ${pkField}: ${pkType}, patch: ${entityName}Patch): Promise<${entityName} | null> {`, () => {
    w.line(`const validated = ${entityName}UpdateSchema.parse(patch);`);
    w.line("// PATCH-5: an empty patch is a no-op — return the current row rather than let");
    w.line("// Drizzle throw on an empty SET clause.");
    writeIf(w, "Object.keys(validated).length === 0", `return ${findByIdFn}(db, ${pkField});`);
    if (supportsReturning(ctx.dialect)) {
      w.line(`const [${singularVar}] = await db.update(${varName}).set(validated)${where}.returning();`);
      w.line(`return ${singularVar} ?? null;`);
    } else {
      w.line("// No RETURNING on this dialect: update, then read the row back (null when absent).");
      w.line(`await db.update(${varName}).set(validated)${where};`);
      w.line(`return ${findByIdFn}(db, ${pkField});`);
    }
  });
}

export function writeDeleteByIdFn(w: TsWriter, entity: MetaObject, ctx: RenderContext): void {
  const varName = ctx.collectionName(entity.name);
  const entityName = entity.name;
  const { fieldName: pkField, tsType: pkType } = getPkInfo(entity, ctx);
  const eq = w.use("eq", "drizzle-orm");
  const where = `.where(${eq}(${varName}.${pkField}, ${pkField}))`;
  w.block(`export async function ${deleteByIdFnName(entityName)}(db: Db, ${pkField}: ${pkType}): Promise<boolean> {`, () => {
    if (!supportsReturning(ctx.dialect)) {
      w.line("// No RETURNING on this dialect, and the affected-row count's shape is driver-specific:");
      w.line("// report whether the row existed, then delete it.");
      writeIf(w, `(await ${findByIdFnName(entityName)}(db, ${pkField})) === null`, "return false;");
      w.line(`await db.delete(${varName})${where};`);
      w.line("return true;");
      return;
    }
    w.line("// Use .returning() unconditionally — supported on SQLite ≥3.35 (covers D1, libsql/Turso)");
    w.line("// and Postgres. Result is an array of deleted rows; presence implies success.");
    w.line(`const deleted = await db.delete(${varName})${where}.returning();`);
    w.line("return deleted.length > 0;");
  });
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
    const fkPath = ref.fields[0];
    const targetRef = ref.targetEntity;
    if (!fkPath || !targetRef) continue;
    // A reference over a flattened value-object member names its flat key on the table.
    const fkField = flatKeyOfPath(entity, fkPath);
    const bound = refTarget(ref, IDENTITY_REFERENCE_ATTR_REFERENCES);
    const target = isMetaObject(bound) ? bound : undefined;
    out.push({ fkField, targetEntity: target?.name ?? stripPackage(targetRef), target });
  }
  return out;
}

/** Write the single + batched reverse finders for one FK on `entity`, a blank line between.
 *  `readVar` (#214) routes the SELECT to a write-through entity's replica view; absent, it
 *  reads the entity's own table (vanilla). */
export function writeReverseFinderFns(w: TsWriter, entity: MetaObject, fk: ReverseFk, ctx: RenderContext, readVar?: string): void {
  const varName = readVar ?? ctx.collectionName(entity.name);
  const entityName = entity.name;
  // The Drizzle table object is keyed by the LOGICAL field name (the DB column
  // name is the argument to integer()/text()), so column access uses fk.fkField.
  // The FK value type is the target entity's PK type (the FK references it). Fall
  // back to the FK field's own subType, then to number (long-shaped key default).
  const targetPk = fk.target === undefined ? undefined : pkInfoOf(fk.target);
  const ownField = entity.findField(fk.fkField);
  const valueType = subTypeToTsType(targetPk?.fieldSubType ?? ownField?.subType ?? "long");
  const eq = w.use("eq", "drizzle-orm");
  const inArray = w.use("inArray", "drizzle-orm");
  const col = `${varName}.${fk.fkField}`;
  w.block(`export async function ${reverseFinderFnName(entity, fk.fkField)}(db: Db, ${fk.fkField}: ${valueType}): Promise<${entityName}[]> {`, () => {
    w.line(`return db.select().from(${varName}).where(${eq}(${col}, ${fk.fkField}));`);
  });
  w.blank();
  w.block(`export async function ${reverseFinderInFnName(entity, fk.fkField)}(db: Db, ${fk.fkField}s: ${valueType}[]): Promise<${entityName}[]> {`, () => {
    writeIf(w, `${fk.fkField}s.length === 0`, "return [];");
    w.line(`return db.select().from(${varName}).where(${inArray}(${col}, ${fk.fkField}s));`);
  });
}

// --- The 1.2 `Code` forms -----------------------------------------------------------------
// An owned 1.2 queries generator joins these `Code` sections itself. They are kept so such a
// copy still loads and compiles (test/owned-generator-skew-compile.test.ts); new code calls
// the `write*` functions above with one writer.

function asCode(write: (w: TsWriter) => void): Code {
  const w = new TsWriter();
  write(w);
  return w.toCode();
}

/** @deprecated Call {@link writeFindByIdFn}. */
export function renderFindByIdFn(entity: MetaObject, ctx: RenderContext, readVar?: string): Code {
  return asCode((w) => writeFindByIdFn(w, entity, ctx, readVar));
}
/** @deprecated Call {@link writeListFn}. */
export function renderListFn(entity: MetaObject, ctx: RenderContext, readVar?: string): Code {
  return asCode((w) => writeListFn(w, entity, ctx, readVar));
}
/** @deprecated Call {@link writeCreateFn}. */
export function renderCreateFn(entity: MetaObject, ctx: RenderContext): Code {
  return asCode((w) => writeCreateFn(w, entity, ctx));
}
/** @deprecated Call {@link writeInsertPreservingFn}. */
export function renderInsertPreservingFn(entity: MetaObject, ctx: RenderContext): Code {
  return asCode((w) => writeInsertPreservingFn(w, entity, ctx));
}
/** @deprecated Call {@link writeUpdateFn}. */
export function renderUpdateFn(entity: MetaObject, ctx: RenderContext): Code {
  return asCode((w) => writeUpdateFn(w, entity, ctx));
}
/** @deprecated Call {@link writeDeleteByIdFn}. */
export function renderDeleteByIdFn(entity: MetaObject, ctx: RenderContext): Code {
  return asCode((w) => writeDeleteByIdFn(w, entity, ctx));
}
/** @deprecated Call {@link writeReverseFinderFns}. */
export function renderReverseFinderFns(entity: MetaObject, fk: ReverseFk, ctx: RenderContext, readVar?: string): Code {
  return asCode((w) => writeReverseFinderFns(w, entity, fk, ctx, readVar));
}
/** @deprecated Call {@link useSchemaInputType}. */
export function schemaInputType(schema: string | Code | ReturnType<typeof imp>): Code {
  return code`${imp("t:z@zod")}.input<typeof ${schema}>`;
}
