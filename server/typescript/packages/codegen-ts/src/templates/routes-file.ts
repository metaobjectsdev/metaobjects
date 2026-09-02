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
} from "@metaobjectsdev/metadata";
import { type RenderContext } from "../render-context.js";
import { crossEntitySpecifier, entityModuleSpecifier, relativeModuleSpecifier } from "../import-path.js";
import { namesRef, columnExpr } from "../names.js";
import { GENERATED_HEADER } from "../constants.js";
import { routesHandlerName } from "../naming.js";
import { isProjection, isWriteThrough } from "../projection/projection-detector.js";
import type { RelationEntry } from "../relation-resolver.js";
import { isTphDiscriminatorBase, tphPlan } from "./tph-discriminator.js";
import { type CrudVerb, exposeLine, intersectExpose } from "../routes-expose.js";

export function renderRoutesFile(
  entity: MetaObject,
  ctx: RenderContext,
  // #348 — resolved by the generator from its `expose` option. undefined = all five verbs,
  // which emits no `expose` key at all and so keeps output byte-identical for projects
  // that do not use it.
  expose?: readonly CrudVerb[],
): string {
  // FR-017 Tier 2 — a TPH discriminator base mounts polymorphic list/get at the
  // base path plus a full per-subtype CRUD route set scoped to each
  // discriminator value. (Subtype entities are filtered out of the routes
  // generator entirely — their routes live here.)
  if (isTphDiscriminatorBase(entity, ctx.loadedRoot)) {
    return renderTphRoutesFile(entity, ctx, expose);
  }

  const entityName = entity.name;
  const handlerName = routesHandlerName(entityName);
  // Import the entity's own file. Same target → relative "./Entity"; cross
  // target → importBase-qualified package path.
  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    entity.package,
    entityName,
    ctx.extStyle,
  );
  const dbImportSpec = relativeModuleSpecifier(ctx.outputLayout, entity.package, ctx.dbImport, ctx.extStyle);

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
  const tableVar = ctx.collectionName(entityName);

  // #214 — a write-through entity (writable table + replica @kind:view + derived
  // origin.passthrough fields) keeps FULL CRUD (writes → table) but its READS must
  // route through the replica view so the HTTP responses carry the derived field.
  // The entity file already exports `<camel>View` as an `.existing()` Drizzle view;
  // import it and pass it as `readView` to mountCrudRoutes. A vanilla entity omits both.
  const writeThrough = isWriteThrough(entity);
  const camelName = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const viewImportLine = writeThrough ? `\n  ${camelName}View,` : "";
  const readViewLinePrefixed = writeThrough ? `\n      readView: ${camelName}View,` : "";
  const readViewLineFlat = writeThrough ? `\n    readView: ${camelName}View,` : "";
  const exposeLinePrefixed = exposeLine(expose, "      ");
  const exposeLineFlat = exposeLine(expose, "    ");

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
  ${tableVar},${viewImportLine}
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
      table: ${tableVar},${readViewLinePrefixed}
      insertSchema: ${entityName}InsertSchema,
      updateSchema: ${entityName}UpdateSchema,
      filterAllowlist: ${entityName}FilterAllowlist,
      sortAllowlist: ${entityName}SortAllowlist,
      dialect: ${JSON.stringify(ctx.dialect)},${exposeLinePrefixed}
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
    table: ${tableVar},${readViewLineFlat}
    insertSchema: ${entityName}InsertSchema,
    updateSchema: ${entityName}UpdateSchema,
    filterAllowlist: ${entityName}FilterAllowlist,
    sortAllowlist: ${entityName}SortAllowlist,
    dialect: ${JSON.stringify(ctx.dialect)},${exposeLineFlat}
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
    `${ctx.collectionName(entry.junctionEntity)}@${crossEntitySpecifier(
      ctx.outputLayout,
      source.package,
      ctx.packageOf.get(entry.junctionEntity),
      entry.junctionEntity,
      ctx.extStyle,
    )}`,
  );
  const targetVarSym = imp(
    `${ctx.collectionName(entry.targetEntity)}@${crossEntitySpecifier(
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
  const sourceColumn: Code = junction
    ? resolveJunctionColumn(junction, entry.sourceJoinField!, ctx)
    : code`${JSON.stringify(entry.sourceJoinField!)}`;
  const targetColumn: Code = junction
    ? resolveJunctionColumn(junction, entry.targetJoinField!, ctx)
    : code`${JSON.stringify(entry.targetJoinField!)}`;
  const targetPkColumn: Code = target
    ? resolveJunctionColumn(target, ctx.pkMap.get(entry.targetEntity)?.fieldName ?? "id", ctx)
    : code`${JSON.stringify("id")}`;

  return code`  ${mountM2mRouteSym}({
    fastify: ${fastifyVar},
    path: ${source.name}.$path,
    relationName: ${JSON.stringify(entry.name)},
    db,
    junctionTable: ${junctionVarSym},
    targetTable: ${targetVarSym},
    sourceColumn: ${sourceColumn},
    targetColumn: ${targetColumn},
    targetPkColumn: ${targetPkColumn},
    symmetric: ${entry.symmetric ? "true" : "false"},
  });`;
}

/**
 * Resolve a field's physical column name on an entity (defaults if missing), as a
 * ts-poet Code fragment.
 *
 * §A6/§B2 — references `<Entity>Names.fields.<field>.column` whenever the names
 * artifact is in this run AND carries the field (the same two-condition shape as every
 * other §A6 site: is the artifact in the run, is the field in it — both PRESENCE
 * guards). A literal otherwise.
 */
function resolveJunctionColumn(entity: MetaObject, fieldName: string, ctx: RenderContext): Code {
  // ADR-0039: resolving — a junction FK field may be inherited via extends.
  const field = entity.children().find((c) => c.type === TYPE_FIELD && c.name === fieldName);
  if (!field) return code`${JSON.stringify(fieldName)}`;
  const dbCol = resolveColumnName(field, ctx.columnNamingStrategy);
  const names = namesRef(entity, ctx);
  return columnExpr(names, field.name, dbCol);
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
function renderTphRoutesFile(
  base: MetaObject,
  ctx: RenderContext,
  expose?: readonly CrudVerb[],
): string {
  const baseName = base.name;
  const handlerName = routesHandlerName(baseName);
  // Single source of truth for the discriminator field + subtypes + route segments.
  const plan = tphPlan(base, ctx.loadedRoot)!;
  const discField = plan.discriminatorField;
  const tableVar = ctx.collectionName(baseName);

  const baseFileSpec = entityModuleSpecifier(
    ctx.selfTarget, ctx.entityModuleTarget, base.package, baseName, ctx.extStyle,
  );
  const dbImportSpec = relativeModuleSpecifier(ctx.outputLayout, base.package, ctx.dbImport, ctx.extStyle);

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

  // The polymorphic mount is read-only BY CONSTRUCTION — the discriminated union has no
  // single writable shape — so an author-supplied `expose` intersects with that fixed set
  // rather than replacing it: it may narrow to just `list`, never widen to `create`.
  const polymorphicExposeLine = exposeLine(intersectExpose(["list", "get"], expose), "      ");
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
      dialect: ${dialectLit},${polymorphicExposeLine}
    });`;

  const subtypeMounts: Code[] = plan.subtypes.map(({ entity: sub, value, routeSegment: segment }) => {
    const subFileSpec = entityModuleSpecifier(
      ctx.selfTarget, ctx.entityModuleTarget, sub.package, sub.name, ctx.extStyle,
    );
    const subInsertSym = imp(`${sub.name}InsertSchema@${subFileSpec}`);
    // FR-036 Program B: the per-subtype UPDATE must carry the FR-035 present-key
    // tristate (a non-@required subtype column accepts an explicit null → clears;
    // a @required column's explicit null is rejected). The subtype's own
    // UpdateSchema encodes exactly that (.optional() + .nullable() for non-required),
    // whereas insertSchema.partial() only makes fields optional, not nullable — so a
    // PATCH {col: null} on a nullable subtype column wrongly 400'd. The base
    // polymorphic mount already uses the base UpdateSchema; this aligns the subtypes.
    const subUpdateSym = imp(`${sub.name}UpdateSchema@${subFileSpec}`);
    // FR-017 Tier 3: each subtype carries its OWN filter/sort allowlist
    // (discriminator excluded — it's pinned by this path).
    const subFilterSym = imp(`${sub.name}FilterAllowlist@${subFileSpec}`);
    const subSortSym = imp(`${sub.name}SortAllowlist@${subFileSpec}`);
    return code`
    ${mountCrudRoutesSym}({
      fastify: ${fastifyRef},
      path: ${baseConstSym}.$path + ${JSON.stringify("/" + segment)},
      db: ${dbSym},
      table: ${tableSym},
      insertSchema: ${subInsertSym}.omit({ ${discField}: true }),
      updateSchema: ${subUpdateSym},
      filterAllowlist: ${subFilterSym},
      sortAllowlist: ${subSortSym},
      dialect: ${dialectLit},
      discriminator: { column: ${JSON.stringify(discField)}, value: ${JSON.stringify(value)} },${exposeLine(expose, "      ")}
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
