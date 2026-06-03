// Fastify route template — emits a per-entity routes file that delegates
// CRUD verbs to helpers from @metaobjectsdev/runtime-ts/drizzle-fastify.
//
// Dispatch logic:
//   isProjection(entity)  → mountReadOnlyCrudRoutes (GET list + GET :id only)
//   vanilla / write-through entity → mountCrudRoutes (all 5 CRUD verbs)
//
// apiPrefix behaviour:
//   ""        → flat mount: mountCrudRoutes({ fastify, ... })
//   "/api"    → wrapped:    fastify.register(async (instance) => {
//                             mountCrudRoutes({ fastify: instance, ... });
//                           }, { prefix: "/api" });
//
// The user's Drizzle `db` instance is imported from ctx.dbImport (matching
// the existing queries-file template). The entity's Drizzle table const is
// imported alongside the Zod schemas + constants from the sibling Entity.ts.

import { code, imp, joinCode, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  TYPE_FIELD,
  resolveColumnName,
  OBJECT_ATTR_DISCRIMINATOR,
  OBJECT_ATTR_DISCRIMINATOR_VALUE,
} from "@metaobjectsdev/metadata";
import { type RenderContext } from "../render-context.js";
import { crossEntitySpecifier, entityModuleSpecifier, relativeModuleSpecifier } from "../import-path.js";
import { GENERATED_HEADER } from "../constants.js";
import { variableNameFromEntity } from "../naming.js";
import { isProjection } from "../projection/projection-detector.js";
import type { RelationEntry } from "../relation-resolver.js";
import { isTphDiscriminatorBase, tphConcreteSubtypes } from "./tph-discriminator.js";

export function renderRoutesFile(entity: MetaObject, ctx: RenderContext): string {
  // FR-017 Tier 2 — a TPH discriminator base mounts polymorphic list/get at the
  // base path plus a full per-subtype CRUD route set scoped to each
  // discriminator value. (Subtype entities are filtered out of the routes
  // generator entirely — their routes live here.)
  if (isTphDiscriminatorBase(entity, ctx.loadedRoot)) {
    return renderTphRoutesFile(entity, ctx);
  }

  const entityName = entity.name;
  const handlerName = `${entityName.charAt(0).toLowerCase()}${entityName.slice(1)}Routes`;
  // Import the entity's own file. Same target → relative "./Entity"; cross
  // target → importBase-qualified package path.
  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    entity.package,
    entityName,
    ctx.extStyle,
  );
  const dbImportSpec = relativeModuleSpecifier(ctx.outputLayout, entity.package, ctx.dbImport);

  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n` +
    `// Customize via ${entityName}.extra.ts in this directory (e.g., auth, additional handlers).\n`;

  // --- Projection path: read-only routes (GET list + GET :id) ---
  if (isProjection(entity)) {
    const camelName = entityName.charAt(0).toLowerCase() + entityName.slice(1);
    const FastifyInstanceSym = imp("t:FastifyInstance@fastify");
    const mountReadOnlyCrudRoutesSym = imp(
      "mountReadOnlyCrudRoutes@@metaobjectsdev/runtime-ts/drizzle-fastify",
    );

    const literalImports = code`
import { db } from ${JSON.stringify(dbImportSpec)};
import {
  ${entityName},
  ${camelName}View,
  ${entityName}FilterAllowlist,
  ${entityName}SortAllowlist,
} from ${JSON.stringify(entityFileSpec)};
`;

    const body = ctx.apiPrefix
      ? code`
/**
 * Mount read-only REST endpoints for ${entityName} (projection — view-backed, no writes).
 *
 * Exposes GET list + GET :id only. POST/PATCH/DELETE return 405.
 * Customize: register this as-is, or import individual route helpers from
 * @metaobjectsdev/runtime-ts/drizzle-fastify.
 */
export async function ${handlerName}(fastify: ${FastifyInstanceSym}) {
  await fastify.register(async (instance) => {
    ${mountReadOnlyCrudRoutesSym}({
      fastify: instance,
      path: ${entityName}.$path,
      db,
      view: ${camelName}View,
      filterAllowlist: ${entityName}FilterAllowlist,
      sortAllowlist: ${entityName}SortAllowlist,
      dialect: ${JSON.stringify(ctx.dialect)},
    });
  }, { prefix: ${JSON.stringify(ctx.apiPrefix)} });
}
`
      : code`
/**
 * Mount read-only REST endpoints for ${entityName} (projection — view-backed, no writes).
 *
 * Exposes GET list + GET :id only. POST/PATCH/DELETE return 405.
 * Customize: register this as-is, or import individual route helpers from
 * @metaobjectsdev/runtime-ts/drizzle-fastify.
 */
export async function ${handlerName}(fastify: ${FastifyInstanceSym}) {
  ${mountReadOnlyCrudRoutesSym}({
    fastify,
    path: ${entityName}.$path,
    db,
    view: ${camelName}View,
    filterAllowlist: ${entityName}FilterAllowlist,
    sortAllowlist: ${entityName}SortAllowlist,
    dialect: ${JSON.stringify(ctx.dialect)},
  });
}
`;

    return header + literalImports.toString() + body.toString();
  }

  // --- Vanilla / write-through entity path: full CRUD routes ---
  const tableVar = variableNameFromEntity(entityName);

  const FastifyInstanceSym = imp("t:FastifyInstance@fastify");
  const mountCrudRoutesSym = imp("mountCrudRoutes@@metaobjectsdev/runtime-ts/drizzle-fastify");

  // FR-018 M:N traversal: for each many-to-many navigation declared on this
  // entity, emit a mountM2mRoute(...) that traverses the junction. The junction
  // FK columns were derived from the junction's identity.reference children (the
  // SSOT) by the relation-resolver pre-pass; here we resolve them to physical
  // column names for the Drizzle two-stage join.
  const m2mEntries = (ctx.relationMap.get(entityName) ?? []).filter(
    (e): e is RelationEntry & { junctionEntity: string } => e.junctionEntity !== undefined,
  );
  // Two fastify-scope variants: under an apiPrefix the mounts live inside the
  // register-block (`instance`); otherwise they bind directly to `fastify`.
  const m2mMountsPrefixed = renderM2mMounts(m2mEntries, entity, ctx, "instance");
  const m2mMountsFlat = renderM2mMounts(m2mEntries, entity, ctx, "fastify");

  const literalImports = code`
import { db } from ${JSON.stringify(dbImportSpec)};
import {
  ${entityName},
  ${tableVar},
  ${entityName}InsertSchema,
  ${entityName}UpdateSchema,
  ${entityName}FilterAllowlist,
  ${entityName}SortAllowlist,
} from ${JSON.stringify(entityFileSpec)};
`;

  const body = ctx.apiPrefix
    ? code`
/**
 * Mount the 5 standard REST endpoints for ${entityName} using Drizzle directly.
 *
 * Customize: register this as-is for stock CRUD, OR import the per-verb
 * helpers (mountListRoute, mountGetRoute, ...) from
 * @metaobjectsdev/runtime-ts/drizzle-fastify and mix with your own handlers
 * (auth, side effects, etc.).
 */
export async function ${handlerName}(fastify: ${FastifyInstanceSym}) {
  await fastify.register(async (instance) => {
    ${mountCrudRoutesSym}({
      fastify: instance,
      path: ${entityName}.$path,
      db,
      table: ${tableVar},
      insertSchema: ${entityName}InsertSchema,
      updateSchema: ${entityName}UpdateSchema,
      filterAllowlist: ${entityName}FilterAllowlist,
      sortAllowlist: ${entityName}SortAllowlist,
      dialect: ${JSON.stringify(ctx.dialect)},
    });
${m2mMountsPrefixed}  }, { prefix: ${JSON.stringify(ctx.apiPrefix)} });
}
`
    : code`
/**
 * Mount the 5 standard REST endpoints for ${entityName} using Drizzle directly.
 *
 * Customize: register this as-is for stock CRUD, OR import the per-verb
 * helpers (mountListRoute, mountGetRoute, ...) from
 * @metaobjectsdev/runtime-ts/drizzle-fastify and mix with your own handlers
 * (auth, side effects, etc.).
 */
export async function ${handlerName}(fastify: ${FastifyInstanceSym}) {
  ${mountCrudRoutesSym}({
    fastify,
    path: ${entityName}.$path,
    db,
    table: ${tableVar},
    insertSchema: ${entityName}InsertSchema,
    updateSchema: ${entityName}UpdateSchema,
    filterAllowlist: ${entityName}FilterAllowlist,
    sortAllowlist: ${entityName}SortAllowlist,
    dialect: ${JSON.stringify(ctx.dialect)},
  });
${m2mMountsFlat}}
`;

  return header + literalImports.toString() + body.toString();
}

/**
 * Render the M:N traversal mounts for an entity as a single Code fragment to
 * interpolate INTO the handler-body code template (so the junction/target table
 * + mountM2mRoute imports hoist with the rest of the body's imports, not inline
 * mid-function). `fastifyVar` is the in-scope Fastify reference (`instance`
 * under an apiPrefix register-block, else `fastify`). Returns "" when the entity
 * has no M:N relationships — CRUD-only output stays byte-identical to before.
 */
function renderM2mMounts(
  entries: ReadonlyArray<RelationEntry & { junctionEntity: string }>,
  source: MetaObject,
  ctx: RenderContext,
  fastifyVar: string,
): Code | string {
  if (entries.length === 0) return "";
  const mounts = entries.map((e) => renderM2mMount(e, source, ctx, fastifyVar));
  return code`${joinCode(mounts, { on: "\n", trim: false })}
`;
}

/**
 * Render one M:N traversal mount. The junction + target Drizzle table consts are
 * imported from their sibling entity files (imp() lets ts-poet track + emit the
 * import). The source/target FK columns + the target PK are resolved to PHYSICAL
 * column names via resolveColumnName (the runtime two-stage join queries by
 * column). mountM2mRoute appends `/:id/<relationName>` to the source $path.
 */
function renderM2mMount(
  entry: RelationEntry & { junctionEntity: string },
  source: MetaObject,
  ctx: RenderContext,
  fastifyVar: string,
): Code {
  const junctionVarSym = imp(
    `${variableNameFromEntity(entry.junctionEntity)}@${crossEntitySpecifier(
      ctx.outputLayout,
      source.package,
      ctx.packageOf.get(entry.junctionEntity),
      entry.junctionEntity,
      ctx.extStyle,
    )}`,
  );
  const targetVarSym = imp(
    `${variableNameFromEntity(entry.targetEntity)}@${crossEntitySpecifier(
      ctx.outputLayout,
      source.package,
      ctx.packageOf.get(entry.targetEntity),
      entry.targetEntity,
      ctx.extStyle,
    )}`,
  );
  const mountM2mRouteSym = imp("mountM2mRoute@@metaobjectsdev/runtime-ts/drizzle-fastify");
  const junction = ctx.loadedRoot.findObject(entry.junctionEntity);
  const target = ctx.loadedRoot.findObject(entry.targetEntity);
  const sourceColumn = junction
    ? resolveJunctionColumn(junction, entry.sourceJoinField!, ctx)
    : entry.sourceJoinField!;
  const targetColumn = junction
    ? resolveJunctionColumn(junction, entry.targetJoinField!, ctx)
    : entry.targetJoinField!;
  const targetPkColumn = target
    ? resolveJunctionColumn(target, ctx.pkMap.get(entry.targetEntity)?.fieldName ?? "id", ctx)
    : "id";

  return code`  ${mountM2mRouteSym}({
    fastify: ${fastifyVar},
    path: ${source.name}.$path,
    relationName: ${JSON.stringify(entry.name)},
    db,
    junctionTable: ${junctionVarSym},
    targetTable: ${targetVarSym},
    sourceColumn: ${JSON.stringify(sourceColumn)},
    targetColumn: ${JSON.stringify(targetColumn)},
    targetPkColumn: ${JSON.stringify(targetPkColumn)},
    symmetric: ${entry.symmetric ? "true" : "false"},
  });`;
}

/** Resolve a field's physical column name on an entity (defaults if missing). */
function resolveJunctionColumn(entity: MetaObject, fieldName: string, ctx: RenderContext): string {
  const field = entity.ownChildren().find((c) => c.type === TYPE_FIELD && c.name === fieldName);
  if (!field) return fieldName;
  return resolveColumnName(field, ctx.columnNamingStrategy);
}

/**
 * FR-017 Tier 2 — the routes file for a TPH discriminator base.
 *
 * Mounts a polymorphic list/get route set at the base path (`GET /auths`,
 * `GET /auths/:id` — rows carry the discriminator by value), then a full
 * per-subtype CRUD route set at `<basePath>/<discriminatorValue lowercased>`
 * (`/auths/bridge`, ...). The per-subtype create body OMITS the discriminator
 * (the URL names the subtype); the runtime helper injects it. The per-subtype
 * route set is scoped to its discriminator value via the `discriminator` option
 * (cross-subtype get/update/delete 404; update strips the discriminator).
 *
 * Subtype route segment defaults to the lowercased `@discriminatorValue`
 * (`"Bridge"` → `bridge`) — a robust, value-derived path that matches the
 * FR-017 design's `/auths/bridge` examples. Fastify resolves the static
 * `/auths/bridge` ahead of the parametric `/auths/:id`, so the two coexist.
 */
function renderTphRoutesFile(base: MetaObject, ctx: RenderContext): string {
  const baseName = base.name;
  const handlerName = `${baseName.charAt(0).toLowerCase()}${baseName.slice(1)}Routes`;
  const discField = base.ownAttr(OBJECT_ATTR_DISCRIMINATOR) as string;
  const tableVar = variableNameFromEntity(baseName);

  const baseFileSpec = entityModuleSpecifier(
    ctx.selfTarget, ctx.entityModuleTarget, base.package, baseName, ctx.extStyle,
  );
  const dbImportSpec = relativeModuleSpecifier(ctx.outputLayout, base.package, ctx.dbImport);

  const FastifyInstanceSym = imp("t:FastifyInstance@fastify");
  const mountCrudRoutesSym = imp("mountCrudRoutes@@metaobjectsdev/runtime-ts/drizzle-fastify");
  const dbSym = imp(`db@${dbImportSpec}`);
  const tableSym = imp(`${tableVar}@${baseFileSpec}`);
  const baseConstSym = imp(`${baseName}@${baseFileSpec}`);
  const baseInsertSym = imp(`${baseName}InsertSchema@${baseFileSpec}`);
  const baseUpdateSym = imp(`${baseName}UpdateSchema@${baseFileSpec}`);
  const baseFilterSym = imp(`${baseName}FilterAllowlist@${baseFileSpec}`);
  const baseSortSym = imp(`${baseName}SortAllowlist@${baseFileSpec}`);

  const fastifyRef = ctx.apiPrefix ? "instance" : "fastify";
  const dialectLit = JSON.stringify(ctx.dialect);

  const polymorphic = code`
    ${mountCrudRoutesSym}({
      fastify: ${fastifyRef},
      path: ${baseConstSym}.$path,
      db: ${dbSym},
      table: ${tableSym},
      insertSchema: ${baseInsertSym},
      updateSchema: ${baseUpdateSym},
      filterAllowlist: ${baseFilterSym},
      sortAllowlist: ${baseSortSym},
      dialect: ${dialectLit},
      expose: ["list", "get"],
    });`;

  const subtypeMounts: Code[] = tphConcreteSubtypes(base, ctx.loadedRoot).map((sub) => {
    const value = sub.ownAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE) as string;
    const segment = value.toLowerCase();
    const subFileSpec = entityModuleSpecifier(
      ctx.selfTarget, ctx.entityModuleTarget, sub.package, sub.name, ctx.extStyle,
    );
    const subInsertSym = imp(`${sub.name}InsertSchema@${subFileSpec}`);
    return code`
    ${mountCrudRoutesSym}({
      fastify: ${fastifyRef},
      path: ${baseConstSym}.$path + ${JSON.stringify("/" + segment)},
      db: ${dbSym},
      table: ${tableSym},
      insertSchema: ${subInsertSym}.omit({ ${discField}: true }),
      updateSchema: ${subInsertSym}.omit({ ${discField}: true }).partial(),
      filterAllowlist: ${baseFilterSym},
      sortAllowlist: ${baseSortSym},
      dialect: ${dialectLit},
      discriminator: { column: ${JSON.stringify(discField)}, value: ${JSON.stringify(value)} },
    });`;
  });

  const mounts = joinCode([polymorphic, ...subtypeMounts], { on: "\n" });

  const fn = ctx.apiPrefix
    ? code`
/**
 * Mount polymorphic + per-subtype REST endpoints for the ${baseName} TPH hierarchy.
 *
 * GET ${baseName}.$path (+ /:id) lists/gets the discriminated union; each
 * /${baseName}.$path/<subtype> path is a full per-subtype CRUD set.
 */
export async function ${handlerName}(fastify: ${FastifyInstanceSym}) {
  await fastify.register(async (instance) => {
${mounts}
  }, { prefix: ${JSON.stringify(ctx.apiPrefix)} });
}
`
    : code`
/**
 * Mount polymorphic + per-subtype REST endpoints for the ${baseName} TPH hierarchy.
 *
 * GET ${baseName}.$path (+ /:id) lists/gets the discriminated union; each
 * /${baseName}.$path/<subtype> path is a full per-subtype CRUD set.
 */
export async function ${handlerName}(fastify: ${FastifyInstanceSym}) {
${mounts}
}
`;

  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${baseName} (${base.fqn()}) — TPH discriminator base\n` +
    `// Customize via ${baseName}.extra.ts in this directory (e.g., auth, additional handlers).\n`;
  return header + fn.toString();
}
