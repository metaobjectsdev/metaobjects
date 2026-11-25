// Queries file composer — composes all CRUD function writers (from queries.ts) into
// a complete <Entity>.queries.ts file with @generated header and correct imports, laid out
// by the code writer (ADR-0063).

import {
  MetaObject,
  OBJECT_ATTR_DISCRIMINATOR,
  OBJECT_ATTR_DISCRIMINATOR_VALUE,
} from "@metaobjectsdev/metadata";
import { type RenderContext } from "@metaobjectsdev/codegen-ts/engine";
import { writeDbType, supportsReturning } from "@metaobjectsdev/codegen-ts/engine";
import { entityModuleSpecifier } from "@metaobjectsdev/codegen-ts/engine";
import {
  writeFindByIdFn,
  writeListFn,
  writeCreateFn,
  writeInsertPreservingFn,
  writeUpdateFn,
  writeDeleteByIdFn,
  writeReverseFinderFns,
  writePagedSelect,
  writeIf,
  reverseFksFor,
  useSchemaInputType,
} from "./queries.js";
import { getPkInfo, getPkFields } from "@metaobjectsdev/codegen-ts/engine";
import { findByIdFnName, listFnName, createFnName, insertPreservingFnName, updateFnName, singleRowVarName } from "@metaobjectsdev/codegen-ts/engine";
import { GENERATED_HEADER, GENERATED_EDIT_NOTE, sidecarComment } from "@metaobjectsdev/codegen-ts/engine";
import { isTphDiscriminatorBase, tphConcreteSubtypes } from "./tph-discriminator.js";
import { isProjection, isWriteThrough } from "@metaobjectsdev/codegen-ts/engine";
import { isReport } from "@metaobjectsdev/codegen-ts/engine";
import { hasItemRoute } from "@metaobjectsdev/codegen-ts/engine";
import { hasAutoSetFields, hasInsertRefinements } from "./zod-validators.js";
import { effectivePackage } from "@metaobjectsdev/codegen-ts/engine";
import { str, TsWriter } from "@metaobjectsdev/codegen-ts/engine";

/**
 * The `<Entity>.queries.ts` module. The `Db` type alias it opens with is the dialect-correct
 * Drizzle database type, parameter-passed into every generated CRUD helper (ADR-0008), so the
 * signatures `find…(db: Db, …)` typecheck without the consumer importing anything to construct one.
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
export function renderQueriesFile(obj: MetaObject, ctx: RenderContext): string {
  const w = new TsWriter();
  writeQueriesFile(w, obj, ctx);
  return w.toString();
}

/** Write {@link renderQueriesFile}'s module into `w`. */
export function writeQueriesFile(w: TsWriter, obj: MetaObject, ctx: RenderContext): void {
  // FR-017 Tier 2 — a TPH discriminator base gets a polymorphic queries file:
  // base reads dispatch through parse<Base>, and per-subtype CRUD targets the
  // single base table scoped to the discriminator value. (Subtype entities are
  // filtered out of the queries generator entirely — their CRUD lives here.)
  if (isTphDiscriminatorBase(obj, ctx.loadedRoot)) {
    writeTphQueriesFile(w, obj, ctx);
    return;
  }

  // A projection is view-backed and read-only: its entity file emits NO
  // InsertSchema and a `<camel>View` instead of a Drizzle table. Emitting the
  // table-style CRUD here (with its `<Name>InsertSchema` import + create/update)
  // references exports that don't exist → TS2724. Mirror routes-file's projection
  // guard: read-only queries (findById + list) selecting from the view.
  if (isProjection(obj)) {
    writeProjectionQueriesFile(w, obj, ctx);
    return;
  }

  // #214 — a write-through entity read-view (FR-024 §7): READS route to the replica
  // view (returning the derived fields), WRITES target the table. A hybrid of the
  // projection read path + the vanilla write path.
  if (isWriteThrough(obj)) {
    writeWriteThroughQueriesFile(w, obj, ctx);
    return;
  }

  const entityName = obj.name;
  writeHeader(w, obj);
  writeDbType(w, ctx.dialect);
  // The typed create inputs are spelled through the schemas (useSchemaInputType), so nothing
  // here names the `<Entity>Create` aliases — an owned copy of this import predating them still works.
  // #203 — an @autoSet entity additionally imports its preserving-shape schema and emits the
  // `insertPreserving<Entity>` escape hatch after `create<Entity>`.
  const autoSet = hasAutoSetFields(obj);
  const spec = entitySpecifier(obj, ctx);
  w.use(ctx.collectionName(entityName), spec);
  w.useType(entityName, spec);
  w.useType(`${entityName}Patch`, spec);
  w.use(`${entityName}InsertSchema`, spec);
  if (autoSet) w.use(`${entityName}InsertPreservingSchema`, spec);
  w.use(`${entityName}UpdateSchema`, spec);

  const sections: Array<() => void> = [
    () => writeFindByIdFn(w, obj, ctx),
    () => writeListFn(w, obj, ctx),
    () => writeCreateFn(w, obj, ctx),
    ...(autoSet ? [() => writeInsertPreservingFn(w, obj, ctx)] : []),
    () => writeUpdateFn(w, obj, ctx),
    () => writeDeleteByIdFn(w, obj, ctx),
  ];
  // ADR-0038 — reverse-relationship navigation via explicit FK finders. Each FK
  // this entity holds (`identity.reference`) gets `find<Plural>By<FkField>` +
  // its batched `…In` sibling, so the referenced entity can navigate back to its
  // referencing rows with a plain, single-query, framework-free read. FK field
  // names are unique within the entity, so the finder names never collide — the
  // same-pair case (3 FKs to one target) yields 3 distinct finders.
  for (const fk of reverseFksFor(obj)) sections.push(() => writeReverseFinderFns(w, obj, fk, ctx));
  writeSections(w, sections);
}

/** The header every queries module opens with; `note` follows the source line after ` — `. */
function writeHeader(w: TsWriter, obj: MetaObject, note?: string): void {
  w.header(
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${obj.name} (${obj.fqn()})${note === undefined ? "" : ` — ${note}`}`,
    sidecarComment(`${obj.name}.extra.ts`),
  );
}

/** The entity module's specifier from this target: relative on the same target, the package path across. */
function entitySpecifier(obj: MetaObject, ctx: RenderContext): string {
  return entityModuleSpecifier(ctx.selfTarget, ctx.entityModuleTarget, effectivePackage(obj), obj.name, ctx.extStyle);
}

/** Each section after a blank line (the first one follows the `Db` alias). */
function writeSections(w: TsWriter, sections: ReadonlyArray<() => void>): void {
  for (const section of sections) {
    w.blank();
    section();
  }
}

/**
 * Read-only queries file for a projection (view-backed, ADR Project E) or a served
 * report's read model (FR-044).
 *
 * Emits `list<Plural>`, plus `find<Name>ById` when the object has an id column
 * (`hasItemRoute`), selecting from the object's `<camel>View` Drizzle view and returning the
 * inferred read type. A keyless projection and every report get the list alone: there is
 * no column to look a row up by, and a by-id function over a made-up `id` does not
 * compile. Deliberately NO create/update/delete and NO `<Name>InsertSchema` import — a
 * read-only object's entity file never exports an insert schema.
 */
function writeProjectionQueriesFile(w: TsWriter, obj: MetaObject, ctx: RenderContext): void {
  const entityName = obj.name;
  const viewVar = `${entityName.charAt(0).toLowerCase() + entityName.slice(1)}View`;
  writeHeader(w, obj, `${isReport(obj) ? "report" : "projection"} (read-only)`);
  writeDbType(w, ctx.dialect);
  const spec = entitySpecifier(obj, ctx);
  w.use(viewVar, spec);
  w.useType(entityName, spec);

  const sections: Array<() => void> = [];
  if (hasItemRoute(obj)) {
    sections.push(() => {
      const { fieldName: pkField, tsType: pkType } = getPkInfo(obj, ctx);
      const eq = w.use("eq", "drizzle-orm");
      w.block(`export async function ${findByIdFnName(entityName)}(db: Db, ${pkField}: ${pkType}): Promise<${entityName} | null> {`, () => {
        w.line(`const [row] = await db.select().from(${viewVar}).where(${eq}(${viewVar}.${pkField}, ${pkField})).limit(1);`);
        w.line("return row ?? null;");
      });
    });
  }
  sections.push(() => {
    w.block(`export async function ${listFnName(obj)}(db: Db, opts?: { limit?: number; offset?: number }): Promise<${entityName}[]> {`, () => {
      writePagedSelect(w, `db.select().from(${viewVar}).$dynamic()`);
      w.line("return q;");
    });
  });
  writeSections(w, sections);
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
function writeWriteThroughQueriesFile(w: TsWriter, obj: MetaObject, ctx: RenderContext): void {
  const entityName = obj.name;
  const viewVar = `${entityName.charAt(0).toLowerCase() + entityName.slice(1)}View`;
  const tableVar = ctx.collectionName(entityName);
  const singularVar = singleRowVarName(entityName, tableVar);
  const { fieldName: pkField, tsType: pkType } = getPkInfo(obj, ctx);
  const pkFields = getPkFields(obj);
  const autoSet = hasAutoSetFields(obj);

  writeHeader(w, obj, "write-through entity read-view (reads → view, writes → table)");
  writeDbType(w, ctx.dialect);
  const spec = entitySpecifier(obj, ctx);
  w.use(viewVar, spec);
  w.use(tableVar, spec);
  w.useType(entityName, spec);
  w.useType(`${entityName}Patch`, spec);
  w.use(`${entityName}InsertSchema`, spec);
  if (autoSet) w.use(`${entityName}InsertPreservingSchema`, spec);
  w.use(`${entityName}UpdateSchema`, spec);

  // The view re-read predicate keyed on ALL primary-key columns of `source` (the
  // insert's returning() row), so a composite PK re-reads the EXACT written row rather
  // than any view row sharing the first key component. `and` is only imported when the
  // PK is composite, so a single-PK entity emits a bare `eq(...)`.
  const viewByAllPk = (source: string): string => {
    const eq = w.use("eq", "drizzle-orm");
    if (pkFields.length <= 1) return `${eq}(${viewVar}.${pkField}, ${source}.${pkField})`;
    const and = w.use("and", "drizzle-orm");
    return `${and}(${pkFields.map((f) => `${eq}(${viewVar}.${f}, ${source}.${f})`).join(", ")})`;
  };

  // A create/insertPreserving writes the table, then reads the persisted row back
  // through the view so the returned <Entity> carries the derived fields.
  //
  // Without RETURNING (MySQL) the written key is the validated row's assigned key columns
  // plus whatever `$returningId()` reports (AUTO_INCREMENT / `$defaultFn`).
  const returning = supportsReturning(ctx.dialect);
  const insertReturningView = (fnName: string, schemaName: string) => () => {
    w.block(`export async function ${fnName}(db: Db, data: ${useSchemaInputType(w, schemaName)}): Promise<${entityName}> {`, () => {
      w.line(`const validated = ${schemaName}.parse(data);`);
      if (returning) {
        w.line(`const [${singularVar}] = await db.insert(${tableVar}).values(validated).returning();`);
        w.line(`const [row] = await db.select().from(${viewVar}).where(${viewByAllPk(`${singularVar}!`)}).limit(1);`);
      } else {
        w.line(`const [inserted] = await db.insert(${tableVar}).values(validated).$returningId();`);
        w.line("const written = { ...validated, ...inserted } as Record<string, unknown>;");
        w.line(`const [row] = await db.select().from(${viewVar}).where(${viewByAllPk("written")}).limit(1);`);
      }
      w.line("return row!;");
    });
  };

  const updateFn = () => {
    const eq = w.use("eq", "drizzle-orm");
    w.block(`export async function ${updateFnName(entityName)}(db: Db, ${pkField}: ${pkType}, patch: ${entityName}Patch): Promise<${entityName} | null> {`, () => {
      w.line(`const validated = ${entityName}UpdateSchema.parse(patch);`);
      w.line("// PATCH-5: an empty patch is a no-op — return the current (view) row.");
      writeIf(w, "Object.keys(validated).length === 0", `return ${findByIdFnName(entityName)}(db, ${pkField});`);
      const where = `.where(${eq}(${tableVar}.${pkField}, ${pkField}))`;
      if (returning) {
        w.line(`const updated = await db.update(${tableVar}).set(validated)${where}.returning();`);
        writeIf(w, "updated.length === 0", "return null;");
      } else {
        w.line(`await db.update(${tableVar}).set(validated)${where};`);
      }
      w.line(`const [row] = await db.select().from(${viewVar}).where(${eq}(${viewVar}.${pkField}, ${pkField})).limit(1);`);
      w.line("return row ?? null;");
    });
  };

  const sections: Array<() => void> = [
    // Reads route to the replica view.
    () => writeFindByIdFn(w, obj, ctx, viewVar),
    () => writeListFn(w, obj, ctx, viewVar),
    // Writes target the table (create/update re-read through the view; delete is boolean).
    insertReturningView(createFnName(entityName), `${entityName}InsertSchema`),
    ...(autoSet ? [insertReturningView(insertPreservingFnName(entityName), `${entityName}InsertPreservingSchema`)] : []),
    updateFn,
    () => writeDeleteByIdFn(w, obj, ctx),
  ];
  // Reverse finders are reads → route to the view.
  for (const fk of reverseFksFor(obj)) sections.push(() => writeReverseFinderFns(w, obj, fk, ctx, viewVar));
  writeSections(w, sections);
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
function writeTphQueriesFile(w: TsWriter, base: MetaObject, ctx: RenderContext): void {
  const baseName = base.name;
  // ADR-0039: own — TPH discriminator, read own to identify the base level.
  const discField = base.ownAttr(OBJECT_ATTR_DISCRIMINATOR) as string;
  const { fieldName: pkField, tsType: pkType } = getPkInfo(base, ctx);

  writeHeader(w, base, "TPH discriminator base");
  writeDbType(w, ctx.dialect);
  const baseSpec = entitySpecifier(base, ctx);
  const table = w.use(ctx.collectionName(baseName), baseSpec);
  const baseType = w.useType(baseName, baseSpec);
  const parse = w.use(`parse${baseName}`, baseSpec);
  const eq = w.use("eq", "drizzle-orm");
  const byPk = `${eq}(${table}.${pkField}, ${pkField})`;

  // --- Polymorphic base reads ---
  const sections: Array<() => void> = [
    () => w.block(`export async function find${baseName}ById(db: Db, ${pkField}: ${pkType}): Promise<${baseType} | null> {`, () => {
      w.line(`const [row] = await db.select().from(${table}).where(${byPk}).limit(1);`);
      w.line(`return row ? ${parse}(row) : null;`);
    }),
    () => w.block(`export async function ${listFnName(base)}(db: Db, opts?: { limit?: number; offset?: number }): Promise<${baseType}[]> {`, () => {
      writePagedSelect(w, `db.select().from(${table}).$dynamic()`);
      w.line("const rows = await q;");
      w.line(`return rows.map((r) => ${parse}(r));`);
    }),
  ];

  // --- Per-subtype CRUD against the single base table ---
  for (const sub of tphConcreteSubtypes(base, ctx.loadedRoot)) {
    sections.push(() => writeTphSubtypeFns(w, sub, ctx, { table, discField, pkField, pkType, byPk }));
  }
  writeSections(w, sections);
}

/** One concrete TPH subtype's list / findById / create / update / delete against the base table. */
function writeTphSubtypeFns(
  w: TsWriter,
  sub: MetaObject,
  ctx: RenderContext,
  t: { table: string; discField: string; pkField: string; pkType: string; byPk: string },
): void {
  const { table, discField, pkField, pkType, byPk } = t;
  // ADR-0039: own — each concrete subtype declares its OWN @discriminatorValue.
  const valueLit = str(sub.ownAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE) as string);
  const subSpec = entitySpecifier(sub, ctx);
  const subType = w.useType(sub.name, subSpec);
  const subSchema = w.use(`${sub.name}Schema`, subSpec);
  const subInsert = w.use(`${sub.name}InsertSchema`, subSpec);
  // Typed write inputs (the subtype's insert-schema INPUT type): a misspelt field is a
  // compile error at the call site; the schema still parses at runtime. Spelled through
  // the schema (useSchemaInputType), so a subtype module from an owned entity generator
  // that predates the `<Sub>Create` alias still satisfies it.
  const subCreate = useSchemaInputType(w, subInsert);
  // A refined (cross-field) InsertSchema has no `.partial()`; the partial update reads
  // the unrefined shape, as an unrefined subtype's does.
  const subPartial = hasInsertRefinements(sub) ? w.use(`${sub.name}InsertBaseSchema`, subSpec) : subInsert;
  const eq = w.use("eq", "drizzle-orm");
  const and = w.use("and", "drizzle-orm");
  const byDisc = `${eq}(${table}.${discField}, ${valueLit})`;
  const scoped = `.where(${and}(${byPk}, ${byDisc}))`;
  const returning = supportsReturning(ctx.dialect);

  w.block(`export async function ${listFnName(sub)}(db: Db, opts?: { limit?: number; offset?: number }): Promise<${subType}[]> {`, () => {
    writePagedSelect(w, `db.select().from(${table}).where(${byDisc}).$dynamic()`);
    w.line("const rows = await q;");
    w.line(`return rows.map((r) => ${subSchema}.parse(r));`);
  });
  w.blank();
  w.block(`export async function find${sub.name}ById(db: Db, ${pkField}: ${pkType}): Promise<${subType} | null> {`, () => {
    w.line(`const [row] = await db.select().from(${table})${scoped}.limit(1);`);
    w.line(`return row ? ${subSchema}.parse(row) : null;`);
  });
  w.blank();
  if (!returning) w.line("// No RETURNING on this dialect: each write reads the row back by key.");
  w.block(`export async function create${sub.name}(db: Db, data: ${subCreate}): Promise<${subType}> {`, () => {
    w.line(`const validated = ${subInsert}.parse(data);`);
    const insert = `await db.insert(${table}).values({ ...validated, ${discField}: ${valueLit} })`;
    if (returning) {
      w.line(`const [row] = ${insert}.returning();`);
      w.line(`return ${subSchema}.parse(row!);`);
      return;
    }
    w.line(`const [inserted] = ${insert}.$returningId();`);
    w.line(`const key = (validated as { ${pkField}?: ${pkType} }).${pkField} ?? (inserted as { ${pkField}?: ${pkType} } | undefined)?.${pkField};`);
    writeIf(w, "key === undefined", `throw new Error("${sub.name}: the insert produced no ${pkField}");`);
    w.line(`return (await find${sub.name}ById(db, key))!;`);
  });
  w.blank();
  w.block(`export async function update${sub.name}ById(db: Db, ${pkField}: ${pkType}, data: Partial<${subCreate}>): Promise<${subType} | null> {`, () => {
    w.line(`const validated = ${subPartial}.partial().parse(data) as Record<string, unknown>;`);
    w.line(`// The discriminator is immutable — a ${sub.name} can never become another subtype.`);
    w.line(`const { [${str(discField)}]: _disc, ...safe } = validated;`);
    if (returning) {
      w.line(`const [row] = await db.update(${table}).set(safe)${scoped}.returning();`);
      w.line(`return row ? ${subSchema}.parse(row) : null;`);
      return;
    }
    w.block("if (Object.keys(safe).length > 0) {", () => {
      w.line(`await db.update(${table}).set(safe)${scoped};`);
    });
    w.line(`return find${sub.name}ById(db, ${pkField});`);
  });
  w.blank();
  w.block(`export async function delete${sub.name}ById(db: Db, ${pkField}: ${pkType}): Promise<boolean> {`, () => {
    if (returning) {
      w.line(`const deleted = await db.delete(${table})${scoped}.returning();`);
      w.line("return deleted.length > 0;");
      return;
    }
    writeIf(w, `(await find${sub.name}ById(db, ${pkField})) === null`, "return false;");
    w.line(`await db.delete(${table})${scoped};`);
    w.line("return true;");
  });
}
