// Queries file composer — composes all CRUD function renderers (from queries.ts) into
// a complete <Entity>.queries.ts file with @generated header and correct imports.

import { code, joinCode, imp, type Code } from "ts-poet";
import {
  MetaObject,
  OBJECT_ATTR_DISCRIMINATOR,
  OBJECT_ATTR_DISCRIMINATOR_VALUE,
} from "@metaobjectsdev/metadata";
import { type RenderContext } from "../render-context.js";
import { entityModuleSpecifier } from "../import-path.js";
import {
  renderFindByIdFn,
  renderListFn,
  renderCreateFn,
  renderInsertPreservingFn,
  renderUpdateFn,
  renderDeleteByIdFn,
  renderReverseFinderFns,
  reverseFksFor,
  getPkInfo,
  getPkFields,
} from "./queries.js";
import { pluralize, findByIdFnName, listFnName, createFnName, insertPreservingFnName, updateFnName } from "../naming.js";
import { GENERATED_HEADER } from "../constants.js";
import { isTphDiscriminatorBase, tphConcreteSubtypes } from "./tph-discriminator.js";
import { isProjection, isWriteThrough } from "../projection/projection-detector.js";
import { hasAutoSetFields } from "./zod-validators.js";

/**
 * The dialect-correct Drizzle `Db` type alias + its import — parameter-passed into every
 * generated CRUD helper (ADR-0008), so the signatures `find…(db: Db, …)` typecheck without
 * the consumer importing anything to construct one. Shared by every queries-file renderer.
 *   - Postgres: `PgDatabase<…>` is the base every PG driver extends (node-postgres,
 *     postgres.js, Neon, Vercel, pglite) — accepts whichever driver the consumer chose.
 *   - SQLite: `BaseSQLiteDatabase<"sync" | "async", …>` accepts BOTH sync (better-sqlite3)
 *     and async (libsql/Turso/D1) drivers; the generated queries `await` results, valid on either.
 *
 * EVERY type argument here must stay as OPEN as Drizzle's own constraint allows — a `Db`
 * this alias cannot name is a helper the consumer cannot call, and generated code that
 * does not compile is indistinguishable from generated code nobody imports. Two axes have
 * now been re-pinned and re-widened in turn, so neither may be narrowed again:
 *   - DRIVER: pinning `NodePgDatabase` / `<"async">` rejected postgres.js and
 *     better-sqlite3. Fixed by dropping to the base classes above.
 *   - SCHEMA (`TFullSchema`): the idiomatic setup is `drizzle(client, { schema })`, which
 *     yields `PgDatabase<…, typeof schema>` / `BaseSQLiteDatabase<…, typeof schema>`.
 *     Leaving this parameter at Drizzle's `Record<string, never>` DEFAULT — spelled out on
 *     postgres, silently inherited on sqlite by supplying only two arguments — rejected
 *     every such db with TS2345 ("Type '\"work_item\"' is not assignable to type 'never'").
 *     `Record<string, unknown>` is verbatim Drizzle's own declared bound
 *     (`TFullSchema extends Record<string, unknown>`), so it admits both a schema-carrying
 *     and a schema-less db without reaching for `any`.
 */
function dbTypeBlock(dialect: "postgres" | "sqlite"): { import: string; alias: string } {
  return dialect === "postgres"
    ? {
        import: `import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";`,
        alias: `type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;`,
      }
    : {
        import: `import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";`,
        alias: `type Db = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;`,
      };
}

export function renderQueriesFile(obj: MetaObject, ctx: RenderContext): string {
  // FR-017 Tier 2 — a TPH discriminator base gets a polymorphic queries file:
  // base reads dispatch through parse<Base>, and per-subtype CRUD targets the
  // single base table scoped to the discriminator value. (Subtype entities are
  // filtered out of the queries generator entirely — their CRUD lives here.)
  if (isTphDiscriminatorBase(obj, ctx.loadedRoot)) {
    return renderTphQueriesFile(obj, ctx);
  }

  // A projection is view-backed and read-only: its entity file emits NO
  // InsertSchema and a `<camel>View` instead of a Drizzle table. Emitting the
  // table-style CRUD here (with its `<Name>InsertSchema` import + create/update)
  // references exports that don't exist → TS2724. Mirror routes-file's projection
  // guard: read-only queries (findById + list) selecting from the view.
  if (isProjection(obj)) {
    return renderProjectionQueriesFile(obj, ctx);
  }

  // #214 — a write-through entity read-view (FR-024 §7): READS route to the replica
  // view (returning the derived fields), WRITES target the table. A hybrid of the
  // projection read path + the vanilla write path.
  if (isWriteThrough(obj)) {
    return renderWriteThroughQueriesFile(obj, ctx);
  }

  const entityName = obj.name;
  // Import the entity's own file. Same target → relative "./Entity"; cross
  // target → importBase-qualified package path.
  const entityFileName = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    obj.package,
    entityName,
    ctx.extStyle,
  );
  const varName = ctx.collectionName(entityName);

  // The persistence-context `db` is parameter-passed into every generated CRUD
  // helper (ADR-0008). Emit the dialect-correct Drizzle type alias so the
  // signatures `findXxx(db: Db, ...)` typecheck without the consumer importing
  // anything to construct one. Consumers pass any compatible Drizzle instance.
  const { import: dbTypeImport, alias: dbTypeAlias } = dbTypeBlock(ctx.dialect);

  // #203 — an @autoSet entity additionally imports its preserving-shape schema
  // and emits the `insertPreserving<Entity>` escape hatch after `create<Entity>`.
  const autoSet = hasAutoSetFields(obj);
  const preservingImport = autoSet ? `, ${entityName}InsertPreservingSchema` : "";

  // Literal imports (Db type + entity types) live in a code block so they sort
  // alongside ts-poet's hoisted imp() imports at the top of the body.
  const literalImports = code`
${dbTypeImport}
${dbTypeAlias}

import { ${varName}, type ${entityName}, type ${entityName}Patch, ${entityName}InsertSchema${preservingImport}, ${entityName}UpdateSchema } from ${JSON.stringify(entityFileName)};
`;

  const sections: Code[] = [
    literalImports,
    renderFindByIdFn(obj, ctx),
    renderListFn(obj, ctx),
    renderCreateFn(obj, ctx),
    ...(autoSet ? [renderInsertPreservingFn(obj, ctx)] : []),
    renderUpdateFn(obj, ctx),
    renderDeleteByIdFn(obj, ctx),
  ];

  // ADR-0038 — reverse-relationship navigation via explicit FK finders. Each FK
  // this entity holds (`identity.reference`) gets `find<Plural>By<FkField>` +
  // its batched `…In` sibling, so the referenced entity can navigate back to its
  // referencing rows with a plain, single-query, framework-free read. FK field
  // names are unique within the entity, so the finder names never collide — the
  // same-pair case (3 FKs to one target) yields 3 distinct finders.
  for (const fk of reverseFksFor(obj)) {
    sections.push(renderReverseFinderFns(obj, fk, ctx));
  }

  // Render ts-poet body first, then prepend the @generated header so it lands
  // at line 1 ahead of any imports.
  const body = joinCode(sections, { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${obj.fqn()})\n` +
    `// Customize via ${entityName}.extra.ts in this directory (additional queries, custom logic).\n`;
  return header + body;
}

/**
 * Read-only queries file for a projection (view-backed, ADR Project E).
 *
 * Emits only `find<Name>ById` + `list<Plural>`, selecting from the projection's
 * `<camel>View` Drizzle view and returning the inferred read type. Deliberately
 * NO create/update/delete and NO `<Name>InsertSchema` import — a projection is
 * read-only and its entity file never exports an insert schema.
 */
function renderProjectionQueriesFile(obj: MetaObject, ctx: RenderContext): string {
  const entityName = obj.name;
  const camelName = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const viewVar = `${camelName}View`;
  const entityFileName = entityModuleSpecifier(
    ctx.selfTarget, ctx.entityModuleTarget, obj.package, entityName, ctx.extStyle,
  );
  const { fieldName: pkField, tsType: pkType } = getPkInfo(obj, ctx);
  const eqSym = imp("eq@drizzle-orm");

  const { import: dbTypeImport, alias: dbTypeAlias } = dbTypeBlock(ctx.dialect);

  const literalImports = code`
${dbTypeImport}
${dbTypeAlias}

import { ${viewVar}, type ${entityName} } from ${JSON.stringify(entityFileName)};
`;

  const reads = code`
export async function ${findByIdFnName(entityName)}(db: Db, ${pkField}: ${pkType}): Promise<${entityName} | null> {
  const [row] = await db.select().from(${viewVar}).where(${eqSym}(${viewVar}.${pkField}, ${pkField})).limit(1);
  return row ?? null;
}

export async function ${listFnName(entityName)}(db: Db, opts?: { limit?: number; offset?: number }): Promise<${entityName}[]> {
  let q = db.select().from(${viewVar}).$dynamic();
  if (opts?.limit !== undefined) q = q.limit(opts.limit);
  if (opts?.offset !== undefined) q = q.offset(opts.offset);
  return q;
}
`;

  const body = joinCode([literalImports, reads], { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${obj.fqn()}) — projection (read-only)\n` +
    `// Customize via ${entityName}.extra.ts in this directory (additional queries, custom logic).\n`;
  return header + body;
}

/**
 * #214 — the queries file for a write-through entity read-view (FR-024 §7).
 *
 * Reads (`find<Name>ById`, `list<Plural>`, reverse finders) SELECT from the replica
 * `<camel>View` so they return the derived fields; writes (`create`/`update`/`delete`)
 * target the write TABLE (derived-free, #213). A create/update re-reads the row THROUGH
 * the view by PK — a derived field is only computable via the view's join, so the
 * returned `<Entity>` (view shape) is read-your-writes correct.
 */
function renderWriteThroughQueriesFile(obj: MetaObject, ctx: RenderContext): string {
  const entityName = obj.name;
  const camelName = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const viewVar = `${camelName}View`;
  const tableVar = ctx.collectionName(entityName);
  const singularVar = camelName;
  const entityFileName = entityModuleSpecifier(
    ctx.selfTarget, ctx.entityModuleTarget, obj.package, entityName, ctx.extStyle,
  );
  const { fieldName: pkField, tsType: pkType } = getPkInfo(obj, ctx);
  const pkFields = getPkFields(obj);
  const eqSym = imp("eq@drizzle-orm");
  const andSym = imp("and@drizzle-orm");
  const autoSet = hasAutoSetFields(obj);

  const { import: dbTypeImport, alias: dbTypeAlias } = dbTypeBlock(ctx.dialect);

  const preservingImport = autoSet ? `, ${entityName}InsertPreservingSchema` : "";
  const literalImports = code`
${dbTypeImport}
${dbTypeAlias}

import { ${viewVar}, ${tableVar}, type ${entityName}, type ${entityName}Patch, ${entityName}InsertSchema${preservingImport}, ${entityName}UpdateSchema } from ${JSON.stringify(entityFileName)};
`;

  // The view re-read predicate keyed on ALL primary-key columns of `source` (the
  // insert's returning() row), so a composite PK re-reads the EXACT written row rather
  // than any view row sharing the first key component. `andSym`/`pkFields[i]` are only
  // referenced when the PK is composite, so a single-PK entity emits a bare `eq(...)`.
  const viewByAllPk = (source: string): Code =>
    pkFields.length > 1
      ? code`${andSym}(${joinCode(pkFields.map((f) => code`${eqSym}(${viewVar}.${f}, ${source}.${f})`), { on: ", " })})`
      : code`${eqSym}(${viewVar}.${pkField}, ${source}.${pkField})`;

  // A create/insertPreserving writes the table, then reads the persisted row back
  // through the view so the returned <Entity> carries the derived fields.
  const insertReturningView = (fnName: string, schemaName: string): Code => code`
export async function ${fnName}(db: Db, data: unknown): Promise<${entityName}> {
  const validated = ${schemaName}.parse(data);
  const [${singularVar}] = await db.insert(${tableVar}).values(validated).returning();
  const [row] = await db.select().from(${viewVar}).where(${viewByAllPk(`${singularVar}!`)}).limit(1);
  return row!;
}
`;

  const updateFn = code`
export async function ${updateFnName(entityName)}(db: Db, ${pkField}: ${pkType}, patch: ${entityName}Patch): Promise<${entityName} | null> {
  const validated = ${entityName}UpdateSchema.parse(patch);
  // PATCH-5: an empty patch is a no-op — return the current (view) row.
  if (Object.keys(validated).length === 0) return ${findByIdFnName(entityName)}(db, ${pkField});
  const updated = await db.update(${tableVar}).set(validated).where(${eqSym}(${tableVar}.${pkField}, ${pkField})).returning();
  if (updated.length === 0) return null;
  const [row] = await db.select().from(${viewVar}).where(${eqSym}(${viewVar}.${pkField}, ${pkField})).limit(1);
  return row ?? null;
}
`;

  const sections: Code[] = [
    literalImports,
    // Reads route to the replica view.
    renderFindByIdFn(obj, ctx, viewVar),
    renderListFn(obj, ctx, viewVar),
    // Writes target the table (create/update re-read through the view; delete is boolean).
    insertReturningView(createFnName(entityName), `${entityName}InsertSchema`),
    ...(autoSet ? [insertReturningView(insertPreservingFnName(entityName), `${entityName}InsertPreservingSchema`)] : []),
    updateFn,
    renderDeleteByIdFn(obj, ctx),
  ];
  // Reverse finders are reads → route to the view.
  for (const fk of reverseFksFor(obj)) {
    sections.push(renderReverseFinderFns(obj, fk, ctx, viewVar));
  }

  const body = joinCode(sections, { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${obj.fqn()}) — write-through entity read-view (reads → view, writes → table)\n` +
    `// Customize via ${entityName}.extra.ts in this directory (additional queries, custom logic).\n`;
  return header + body;
}

/**
 * FR-017 Tier 2 — the polymorphic + per-subtype queries file for a TPH base.
 *
 * Base reads (`find<Base>ById`, `list<BasePlural>`) project every row through
 * `parse<Base>` so they return the discriminated union. There is intentionally
 * NO `create<Base>` / `update<Base>` — you cannot instantiate an abstract base.
 *
 * Each concrete subtype gets list / findById (filtered to the discriminator
 * value, parsed with `<Sub>Schema`) plus create / updateById / deleteById, all
 * against the single base table. Creates inject the discriminator value;
 * updates strip it (a row's subtype is immutable).
 */
function renderTphQueriesFile(base: MetaObject, ctx: RenderContext): string {
  const baseName = base.name;
  const tableVar = ctx.collectionName(baseName);
  // ADR-0039: own — TPH discriminator, read own to identify the base level.
  const discField = base.ownAttr(OBJECT_ATTR_DISCRIMINATOR) as string;
  const { fieldName: pkField, tsType: pkType } = getPkInfo(base, ctx);

  const baseFileSpec = entityModuleSpecifier(
    ctx.selfTarget, ctx.entityModuleTarget, base.package, baseName, ctx.extStyle,
  );
  const tableSym = imp(`${tableVar}@${baseFileSpec}`);
  const baseTypeSym = imp(`t:${baseName}@${baseFileSpec}`);
  const parseSym = imp(`parse${baseName}@${baseFileSpec}`);
  const eqSym = imp("eq@drizzle-orm");
  const andSym = imp("and@drizzle-orm");

  const { import: dbTypeImport, alias: dbTypeAlias } = dbTypeBlock(ctx.dialect);

  // --- Polymorphic base reads ---
  const polymorphic = code`
export async function find${baseName}ById(db: Db, ${pkField}: ${pkType}): Promise<${baseTypeSym} | null> {
  const [row] = await db.select().from(${tableSym}).where(${eqSym}(${tableSym}.${pkField}, ${pkField})).limit(1);
  return row ? ${parseSym}(row) : null;
}

export async function list${pluralize(baseName)}(db: Db, opts?: { limit?: number; offset?: number }): Promise<${baseTypeSym}[]> {
  let q = db.select().from(${tableSym}).$dynamic();
  if (opts?.limit !== undefined) q = q.limit(opts.limit);
  if (opts?.offset !== undefined) q = q.offset(opts.offset);
  const rows = await q;
  return rows.map((r) => ${parseSym}(r));
}
`;

  // --- Per-subtype CRUD against the single base table ---
  const subtypeSections: Code[] = [];
  for (const sub of tphConcreteSubtypes(base, ctx.loadedRoot)) {
    // ADR-0039: own — each concrete subtype declares its OWN @discriminatorValue.
    const value = sub.ownAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE) as string;
    const valueLit = JSON.stringify(value);
    const subFileSpec = entityModuleSpecifier(
      ctx.selfTarget, ctx.entityModuleTarget, sub.package, sub.name, ctx.extStyle,
    );
    const subTypeSym = imp(`t:${sub.name}@${subFileSpec}`);
    const subSchemaSym = imp(`${sub.name}Schema@${subFileSpec}`);
    const subInsertSym = imp(`${sub.name}InsertSchema@${subFileSpec}`);

    subtypeSections.push(code`
export async function list${pluralize(sub.name)}(db: Db, opts?: { limit?: number; offset?: number }): Promise<${subTypeSym}[]> {
  let q = db.select().from(${tableSym}).where(${eqSym}(${tableSym}.${discField}, ${valueLit})).$dynamic();
  if (opts?.limit !== undefined) q = q.limit(opts.limit);
  if (opts?.offset !== undefined) q = q.offset(opts.offset);
  const rows = await q;
  return rows.map((r) => ${subSchemaSym}.parse(r));
}

export async function find${sub.name}ById(db: Db, ${pkField}: ${pkType}): Promise<${subTypeSym} | null> {
  const [row] = await db.select().from(${tableSym})
    .where(${andSym}(${eqSym}(${tableSym}.${pkField}, ${pkField}), ${eqSym}(${tableSym}.${discField}, ${valueLit}))).limit(1);
  return row ? ${subSchemaSym}.parse(row) : null;
}

export async function create${sub.name}(db: Db, data: unknown): Promise<${subTypeSym}> {
  const validated = ${subInsertSym}.parse(data);
  const [row] = await db.insert(${tableSym}).values({ ...validated, ${discField}: ${valueLit} }).returning();
  return ${subSchemaSym}.parse(row!);
}

export async function update${sub.name}ById(db: Db, ${pkField}: ${pkType}, data: unknown): Promise<${subTypeSym} | null> {
  const validated = ${subInsertSym}.partial().parse(data) as Record<string, unknown>;
  // The discriminator is immutable — a ${sub.name} can never become another subtype.
  const { [${JSON.stringify(discField)}]: _disc, ...safe } = validated;
  const [row] = await db.update(${tableSym}).set(safe)
    .where(${andSym}(${eqSym}(${tableSym}.${pkField}, ${pkField}), ${eqSym}(${tableSym}.${discField}, ${valueLit}))).returning();
  return row ? ${subSchemaSym}.parse(row) : null;
}

export async function delete${sub.name}ById(db: Db, ${pkField}: ${pkType}): Promise<boolean> {
  const deleted = await db.delete(${tableSym})
    .where(${andSym}(${eqSym}(${tableSym}.${pkField}, ${pkField}), ${eqSym}(${tableSym}.${discField}, ${valueLit}))).returning();
  return deleted.length > 0;
}
`);
  }

  const literalImports = code`
${dbTypeImport}
${dbTypeAlias}
`;

  const body = joinCode([literalImports, polymorphic, ...subtypeSections], { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${baseName} (${base.fqn()}) — TPH discriminator base\n` +
    `// Customize via ${baseName}.extra.ts in this directory (additional queries, custom logic).\n`;
  return header + body;
}
