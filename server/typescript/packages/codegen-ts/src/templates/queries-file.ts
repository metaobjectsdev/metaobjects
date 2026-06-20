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
  renderUpdateFn,
  renderDeleteByIdFn,
  getPkInfo,
} from "./queries.js";
import { pluralize } from "../naming.js";
import { GENERATED_HEADER } from "../constants.js";
import { isTphDiscriminatorBase, tphConcreteSubtypes } from "./tph-discriminator.js";

export function renderQueriesFile(obj: MetaObject, ctx: RenderContext): string {
  // FR-017 Tier 2 — a TPH discriminator base gets a polymorphic queries file:
  // base reads dispatch through parse<Base>, and per-subtype CRUD targets the
  // single base table scoped to the discriminator value. (Subtype entities are
  // filtered out of the queries generator entirely — their CRUD lives here.)
  if (isTphDiscriminatorBase(obj, ctx.loadedRoot)) {
    return renderTphQueriesFile(obj, ctx);
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
  const dbTypeImport =
    ctx.dialect === "postgres"
      ? `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`
      : `import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";`;
  const dbTypeAlias =
    ctx.dialect === "postgres"
      ? `type Db = NodePgDatabase<Record<string, never>>;`
      : `type Db = BaseSQLiteDatabase<"async", Record<string, never>>;`;

  // Literal imports (Db type + entity types) live in a code block so they sort
  // alongside ts-poet's hoisted imp() imports at the top of the body.
  const literalImports = code`
${dbTypeImport}
${dbTypeAlias}

import { ${varName}, type ${entityName}, ${entityName}InsertSchema } from ${JSON.stringify(entityFileName)};
`;

  const sections: Code[] = [
    literalImports,
    renderFindByIdFn(obj, ctx),
    renderListFn(obj, ctx),
    renderCreateFn(obj, ctx),
    renderUpdateFn(obj, ctx),
    renderDeleteByIdFn(obj, ctx),
  ];

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

  const dbTypeImport =
    ctx.dialect === "postgres"
      ? `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`
      : `import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";`;
  const dbTypeAlias =
    ctx.dialect === "postgres"
      ? `type Db = NodePgDatabase<Record<string, never>>;`
      : `type Db = BaseSQLiteDatabase<"async", Record<string, never>>;`;

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
