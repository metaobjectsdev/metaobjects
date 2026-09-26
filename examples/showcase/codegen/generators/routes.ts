// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/routes.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { routesFile } from "./codegen/generators/routes.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Fastify + Drizzle. The emitted file calls `mountCrudRoutes` /
//                `mountReadOnlyCrudRoutes` / `mountM2mRoute` and binds a module-singleton
//                `db`. THIS is the file to retarget for another HTTP framework; see also
//                the routes-hono template, whose deps-injected shape ports more easily to
//                hosts that hand you a request.
// use-when:      you want generated Fastify REST routes per entity. Drop it and hand-write routes
//                if you need bespoke endpoints — or keep it and register extra handlers YOURSELF
//                alongside the generated `register<Entity>Routes(app)` call. Nothing here
//                discovers a sibling module: a `<Entity>.extra.ts` next to the output is a naming
//                convention, not a plugin point, so its handlers only mount if your server calls them.
// emits:         <target>/<Entity>.routes.ts — full CRUD for write-through entities, read-only
//                (GET list + GET :id) for projections, polymorphic + per-subtype for TPH bases.
//                Skipped for any sourceless object (incl. every object.value, source-less by
//                value purity) and for TPH subtypes — no source.rdb means no table/allowlist
//                for a routes file to import (#248 R2).
// owns:          ALL of it. The route COMPOSITION is below (CRUD, read-only projections, M:N
//                traversal, TPH per-subtype route sets), not a call into the engine — edit
//                `renderRoutes` to change what is emitted. And the emitted file does not import
//                its mount helpers from `@metaobjectsdev/runtime-ts`: `meta eject routes` also
//                copied their SOURCE (the Drizzle/Fastify adapter, filter parser, error
//                envelopes, pagination) into `codegen/runtime/`, and the emitted imports point
//                there. Fix an adapter defect in that copy; nothing waits on a release.
//                `runtimeImport` moves the copy (relative to the output root, like `dbImport`,
//                or a path alias); `runtimeImport: "@metaobjectsdev/runtime-ts"` goes back to
//                the package. `meta eject --list` reports whether each copied file still
//                matches the package it came from.
// customize:     this generator (filter, output path, target) is YOURS — edit it freely.
//                Decide per generator what you consume: wire only the generators whose
//                output you actually import, and narrow this one with its `filter`. There
//                is no `@emit*` metadata attribute — those were never registered
//                vocabulary, so `meta verify` rejects them (ERR_UNKNOWN_ATTR). For per-verb
//                control, import the mount* helpers from your copy in `codegen/runtime/` and
//                mix them with your own handlers (auth, side effects).
// composes-with: entity.ts (imports the table/schemas/allowlists), queries.ts.
//
// The composition (`renderRoutes`) is the relocated body of the engine's `renderRoutesFile`
// — byte-identical output to start, now YOURS to change. It imports only public engine
// primitives.

// ts-poet combinators come from the engine package, NOT a bare "ts-poet" import: the Code
// fragments composed here must share ONE ts-poet instance with the engine's, or (with a
// globally-installed / linked CLI) imports split into duplicate headers.
import { code, imp, joinCode, type Code } from "@metaobjectsdev/codegen-ts";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { TYPE_FIELD, resolveColumnName } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  type RenderContext,
  type RelationEntry,
  resolveExpose,
  type ExposeOption,
  type CrudVerb,
  authSeamJsDoc,
  exposeLine,
  intersectExpose,
  TPH_POLYMORPHIC_VERBS,
  isTphSubtype,
  isTphDiscriminatorBase,
  tphPlan,
  tphDiscriminatorPin,
  tphStorageObject,
  isProjection,
  isWriteThrough,
  servesReadApi,
  formatTs,
  renderRoutesIndex,
  routesIndexFileName,
  entityOutputPath,
  effectivePackage,
  crossEntitySpecifier,
  entityModuleSpecifier,
  relativeModuleSpecifier,
  namesRef,
  columnExpr,
  routesHandlerName,
  httpRuntimeSpecifier,
  ownedRuntimeImport,
  GENERATED_HEADER,
  GENERATED_EDIT_NOTE,
  sidecarLine,
} from "@metaobjectsdev/codegen-ts";

// --- composition (OWNED) — assembles one <Entity>.routes.ts. Change this to change the output. ---
// Dispatch: a TPH discriminator base → polymorphic list/get + a per-subtype CRUD set; a
// projection → mountReadOnlyCrudRoutes (GET list + GET :id); every other writable entity →
// mountCrudRoutes (+ one mountM2mRoute per M:N navigation). Under an `apiPrefix` the mounts
// are wrapped in `fastify.register(..., { prefix })`.

function renderRoutes(
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
    return renderTphRoutes(entity, ctx, expose);
  }

  const entityName = entity.name;
  const handlerName = routesHandlerName(entityName);
  const entityPkg = effectivePackage(entity);
  // Import the entity's own file. Same target → relative "./Entity"; cross
  // target → importBase-qualified package path.
  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    entityPkg,
    entityName,
    ctx.extStyle,
  );
  const dbImportSpec = relativeModuleSpecifier(ctx.outputLayout, entityPkg, ctx.dbImport, ctx.extStyle);

  const header =
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n${sidecarLine(`${entityName}.extra.ts`)}`;

  // Where the mount helpers come from: the package, or an owned copy (owned-runtime.ts).
  const runtimeSpec = httpRuntimeSpecifier("drizzle-fastify", ctx, entityPkg);

  // --- Projection path: read-only routes (GET list + GET :id) ---
  if (isProjection(entity)) {
    const camelName = entityName.charAt(0).toLowerCase() + entityName.slice(1);
    const FastifyInstanceSym = imp("t:FastifyInstance@fastify");
    const mountReadOnlyCrudRoutesSym = imp(`mountReadOnlyCrudRoutes@${runtimeSpec}`);
    // A projection mount is read-only by construction, so `expose` cannot narrow it —
    // the paragraph drops the narrowing advice and keeps the auth seam.
    const readOnlyAuthJsDoc = authSeamJsDoc({
      framework: "fastify",
      handlerName,
      narrowable: false,
    });

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
 * ${runtimeSpec}.
${readOnlyAuthJsDoc}
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
 * ${runtimeSpec}.
${readOnlyAuthJsDoc}
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
  const crudAuthJsDoc = authSeamJsDoc({ framework: "fastify", handlerName, narrowable: true });

  const FastifyInstanceSym = imp("t:FastifyInstance@fastify");
  const mountCrudRoutesSym = imp(`mountCrudRoutes@${runtimeSpec}`);

  // FR-018 M:N traversal: for each many-to-many navigation declared on this
  // entity, emit a mountM2mRoute(...) that traverses the junction. The junction
  // FK columns were derived from the junction's identity.reference children (the
  // SSOT) by the relation-resolver pre-pass; here we resolve them to physical
  // column names for the Drizzle two-stage join.
  const m2mEntries = m2mEntriesOf(ctx, entityName);
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
 * ${runtimeSpec} and mix with your own handlers
 * (auth, side effects, etc.).
${crudAuthJsDoc}
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
 * ${runtimeSpec} and mix with your own handlers
 * (auth, side effects, etc.).
${crudAuthJsDoc}
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
 * The M:N navigation entries of `name` — the ONE rule for which relationships get a
 * traversal mount. The vanilla entity path and the TPH path both go through it, so
 * they cannot drift apart: a rule change moves every mount at once, and the
 * independent oracle's route rule stays checkable against both emit paths alike.
 */
function m2mEntriesOf(
  ctx: RenderContext,
  name: string,
): Array<RelationEntry & { junctionEntity: string }> {
  return (ctx.relationMap.get(name) ?? []).filter(
    (e): e is RelationEntry & { junctionEntity: string } => e.junctionEntity !== undefined,
  );
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
  tphSource?: TphM2mSource,
): Code | string {
  if (entries.length === 0) return "";
  const mounts = entries.map((e) => renderM2mMount(e, source, ctx, fastifyVar, tphSource));
  return code`${joinCode(mounts, { on: "\n", trim: false })}
`;
}

/**
 * Where a TPH M:N mount hangs, and how it proves the source id is really ITS subtype's.
 *
 * Only `renderTphRoutes` supplies this, and only for a relationship declared ON a
 * subtype. The path gains that subtype's segment, and `sourceDiscriminator` gets the
 * check that makes the segment mean something: the junction FK points at the shared base
 * table, so without it a sibling subtype's id reaches the same junction rows and the
 * segment in the URL is decorative. A relationship declared on the BASE passes nothing
 * here — every row of the table is a legitimate source — so its mount is byte-identical
 * to a vanilla entity's.
 */
interface TphM2mSource {
  /** Appended to the base entity's `$path`, e.g. `"/bridge"`. */
  pathSuffix: string;
  /** The base table const this subtype's rows live in. */
  table: Code | string;
  /** Physical PK column of the base table. */
  pkColumn: Code;
  /** Physical discriminator column of the base table. */
  discriminatorColumn: Code;
  /** This subtype's `@discriminatorValue`. */
  value: string;
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
  tphSource?: TphM2mSource,
): Code {
  // `source` never changes across this function, so its effective package is computed
  // once and reused below (both crossEntitySpecifier calls, and the three
  // resolveJunctionColumn calls' `fromPackage` — see that comment for why it must be
  // SOURCE's package rather than the junction/target entity's own).
  const sourcePkg = effectivePackage(source);
  const junctionVarSym = imp(
    `${ctx.collectionName(entry.junctionEntity)}@${crossEntitySpecifier(
      ctx.outputLayout,
      sourcePkg,
      ctx.packageOf.get(entry.junctionEntity),
      entry.junctionEntity,
      ctx.extStyle,
    )}`,
  );
  // An M:N onto a TPH subtype traverses into its discriminator BASE's table — the
  // subtype has no table const, and the junction FK can only point at the base table —
  // and filters the rows to the subtype, because a Broker id in that FK column is not a
  // Carrier. Every other target binds to itself, and emits no filter.
  const declaredTarget = ctx.loadedRoot.findObject(entry.targetEntity);
  const target = declaredTarget === undefined ? undefined : tphStorageObject(declaredTarget);
  const targetTableEntity = target?.name ?? entry.targetEntity;
  const pin = declaredTarget === undefined ? undefined : tphDiscriminatorPin(declaredTarget);
  // A self-join's target table IS the source table, which this file already imports from
  // the entity module; a second import of the same binding is TS2300, and a SyntaxError
  // when Node loads the module.
  const targetVarSym = targetTableEntity === source.name
    ? ctx.collectionName(source.name)
    : imp(
      `${ctx.collectionName(targetTableEntity)}@${crossEntitySpecifier(
        ctx.outputLayout,
        sourcePkg,
        ctx.packageOf.get(targetTableEntity),
        targetTableEntity,
        ctx.extStyle,
      )}`,
    );
  const mountM2mRouteSym = imp(`mountM2mRoute@${httpRuntimeSpecifier("drizzle-fastify", ctx, sourcePkg)}`);
  const junction = ctx.loadedRoot.findObject(entry.junctionEntity);
  // fromPackage = source.package: this routes file is SOURCE's own module, never the
  // junction's or the target's — see resolveJunctionColumn's doc comment (B1).
  // The relation-resolver pre-pass derives both join fields for every M:N entry.
  const { sourceJoinField, targetJoinField } = entry;
  if (sourceJoinField === undefined || targetJoinField === undefined) {
    throw new Error(`routes-file: M:N "${entry.name}" on ${source.name} has no derived join fields`);
  }
  const sourceColumn: Code = junction
    ? resolveJunctionColumn(junction, sourceJoinField, ctx, sourcePkg)
    : code`${JSON.stringify(sourceJoinField)}`;
  const targetColumn: Code = junction
    ? resolveJunctionColumn(junction, targetJoinField, ctx, sourcePkg)
    : code`${JSON.stringify(targetJoinField)}`;
  const targetPkColumn: Code = target
    ? resolveJunctionColumn(target, ctx.pkMap.get(targetTableEntity)?.fieldName ?? "id", ctx, sourcePkg)
    : code`${JSON.stringify("id")}`;
  const discriminatorLine: Code | string = pin !== undefined && target !== undefined
    ? code`
    targetDiscriminator: { column: ${resolveJunctionColumn(target, pin.fieldName, ctx, sourcePkg)}, value: ${JSON.stringify(pin.value)} },`
    : "";

  // A subtype-declared M:N hangs under the subtype's segment; everything else hangs at
  // the source entity's own path. `$path` is read from the BASE const either way — a TPH
  // subtype's module exports no entity const of its own.
  const pathExpr: Code = tphSource === undefined
    ? code`${source.name}.$path`
    : code`${source.name}.$path + ${JSON.stringify(tphSource.pathSuffix)}`;
  const sourceDiscriminatorLine: Code | string = tphSource === undefined
    ? ""
    : code`
    sourceDiscriminator: { table: ${tphSource.table}, pkColumn: ${tphSource.pkColumn}, column: ${tphSource.discriminatorColumn}, value: ${JSON.stringify(tphSource.value)} },`;

  return code`  ${mountM2mRouteSym}({
    fastify: ${fastifyVar},
    path: ${pathExpr},
    relationName: ${JSON.stringify(entry.name)},
    db,
    junctionTable: ${junctionVarSym},
    targetTable: ${targetVarSym},
    sourceColumn: ${sourceColumn},
    targetColumn: ${targetColumn},
    targetPkColumn: ${targetPkColumn},
    symmetric: ${entry.symmetric ? "true" : "false"},${discriminatorLine}${sourceDiscriminatorLine}
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
 *
 * B1 — `entity` here is the JUNCTION or TARGET object, never the routes file's own
 * SOURCE entity (see renderM2mMount) — so `fromPackage` MUST be the source entity's
 * package, not `entity`'s own. A same-package caller cannot tell the two apart (they're
 * equal), which is exactly how this went unnoticed until a package-layout M:N golden
 * existed: a plain sibling specifier (assuming fromPackage === entity.package, the
 * shape `namesRef`'s default deliberately does NOT special-case) silently produced a
 * same-directory import for a names artifact that lives in a DIFFERENT directory,
 * because the object whose file we're building and the object whose names we're
 * importing are two different objects.
 */
function resolveJunctionColumn(
  entity: MetaObject,
  fieldName: string,
  ctx: RenderContext,
  fromPackage: string | undefined,
): Code {
  // ADR-0039: resolving — a junction FK field may be inherited via extends.
  const field = entity.children().find((c) => c.type === TYPE_FIELD && c.name === fieldName);
  if (!field) return code`${JSON.stringify(fieldName)}`;
  const dbCol = resolveColumnName(field, ctx.columnNamingStrategy);
  const names = namesRef(entity, ctx, fromPackage);
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
function renderTphRoutes(
  base: MetaObject,
  ctx: RenderContext,
  expose?: readonly CrudVerb[],
): string {
  const baseName = base.name;
  const handlerName = routesHandlerName(baseName);
  // Single source of truth for the discriminator field + subtypes + route segments.
  const plan = tphPlan(base, ctx.loadedRoot);
  if (plan === null) {
    throw new Error(`routes-file: ${baseName} is not a TPH discriminator base`);
  }
  const discField = plan.discriminatorField;
  const tableVar = ctx.collectionName(baseName);

  const basePkg = effectivePackage(base);
  const baseFileSpec = entityModuleSpecifier(
    ctx.selfTarget, ctx.entityModuleTarget, basePkg, baseName, ctx.extStyle,
  );
  const dbImportSpec = relativeModuleSpecifier(ctx.outputLayout, basePkg, ctx.dbImport, ctx.extStyle);

  const FastifyInstanceSym = imp("t:FastifyInstance@fastify");
  const mountCrudRoutesSym = imp(`mountCrudRoutes@${httpRuntimeSpecifier("drizzle-fastify", ctx, basePkg)}`);
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
  const polymorphicExposeLine = exposeLine(intersectExpose([...TPH_POLYMORPHIC_VERBS], expose), "      ");
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

  // FR-018 x FR-017 — M:N traversal inside a TPH hierarchy. This file never consulted
  // the relation map at all, so BOTH sides vanished from the generated API: a
  // relationship declared on the base (every row of the table is a legitimate source)
  // and one declared on a subtype (only that subtype's rows are). Neither is a compile
  // error — a route that is never mounted is an absence — which is why the codegen
  // compile gate stayed green while the endpoint 404'd.
  //
  // The physical columns stage 0 needs, resolved once against the base's own table.
  const basePkField = ctx.pkMap.get(baseName)?.fieldName ?? "id";
  const basePkColumn = resolveJunctionColumn(base, basePkField, ctx, basePkg);
  const baseDiscColumn = resolveJunctionColumn(base, discField, ctx, basePkg);
  const baseM2mMounts = renderM2mMounts(m2mEntriesOf(ctx, baseName), base, ctx, fastifyRef);

  const subtypeMounts: Code[] = plan.subtypes.flatMap(({ entity: sub, value, routeSegment: segment }) => {
    const subFileSpec = entityModuleSpecifier(
      ctx.selfTarget, ctx.entityModuleTarget, effectivePackage(sub), sub.name, ctx.extStyle,
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
    const crud = code`
    ${mountCrudRoutesSym}({
      fastify: ${fastifyRef},
      path: ${baseConstSym}.$path + ${JSON.stringify(`/${segment}`)},
      db: ${dbSym},
      table: ${tableSym},
      insertSchema: ${subInsertSym}.omit({ ${discField}: true }),
      updateSchema: ${subUpdateSym},
      filterAllowlist: ${subFilterSym},
      sortAllowlist: ${subSortSym},
      dialect: ${dialectLit},
      discriminator: { column: ${JSON.stringify(discField)}, value: ${JSON.stringify(value)} },${exposeLine(expose, "      ")}
    });`;
    // This subtype's own M:N navigations, mounted beneath its segment and gated on the
    // discriminator so a sibling's id yields [] instead of the sibling's relations.
    //
    // Every relationship this subtype RESOLVES, inherited ones included — not just the
    // ones it declares. A subtype resource is a resource: `/auths/bridge/1` carries the
    // same sub-resources as any other, so it carries the base's relationships too, and
    // an abstract mid level's relationship has nowhere else to be served at all.
    //
    // The base mounts its own set separately, at its own path. The overlap is deliberate
    // and not redundant: `/auths/1/tags` accepts any row of the table, while
    // `/auths/bridge/1/tags` answers [] for a Copay id — the segment is a type
    // assertion, which is exactly what sourceDiscriminator enforces below.
    const subM2m = renderM2mMounts(m2mEntriesOf(ctx, sub.name), base, ctx, fastifyRef, {
      pathSuffix: `/${segment}`,
      table: code`${tableSym}`,
      pkColumn: basePkColumn,
      discriminatorColumn: baseDiscColumn,
      value,
    });
    return subM2m === "" ? [crud] : [crud, subM2m as Code];
  });

  const mounts = joinCode(
    [polymorphic, ...(baseM2mMounts === "" ? [] : [baseM2mMounts as Code]), ...subtypeMounts],
    { on: "\n" },
  );
  // The base path is read-only by construction (TPH_POLYMORPHIC_VERBS), but the
  // per-subtype mounts below it are full CRUD — so `expose` does narrow this file.
  const tphAuthJsDoc = authSeamJsDoc({ framework: "fastify", handlerName, narrowable: true });

  const fn = ctx.apiPrefix
    ? code`
/**
 * Mount polymorphic + per-subtype REST endpoints for the ${baseName} TPH hierarchy.
 *
 * GET ${baseName}.$path (+ /:id) lists/gets the discriminated union; each
 * /${baseName}.$path/<subtype> path is a full per-subtype CRUD set.
${tphAuthJsDoc}
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
${tphAuthJsDoc}
 */
export async function ${handlerName}(fastify: ${FastifyInstanceSym}) {
${mounts}
}
`;

  const header =
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}\n` +
    `// Source metadata: ${baseName} (${base.fqn()}) — TPH discriminator base\n${sidecarLine(`${baseName}.extra.ts`)}`;
  return header + fn.toString();
}

export interface RoutesFileOpts {
  filter?: (entity: MetaObject) => boolean;
  /**
   * Which CRUD verbs the emitted file mounts (#348). Verbs, or a per-entity function;
   * absent means all five and emits byte-identical output.
   *
   *   routesFile({ expose: (e) => e.name === "AuditEntry" ? ["list", "get"] : undefined })
   *
   * A `filter` cannot express this — it decides whether the file emits AT ALL, so it can
   * only remove the whole surface, not restrict it to a subset of verbs.
   */
  expose?: ExposeOption;
  /**
   * Also emit `routes.index.ts` at the target root: one `registerAllRoutes(...)` that registers every
   * entity this generator emitted a routes file for, so adding an entity needs no edit to
   * your host file. Off by default, so a project that does not ask gets no new file.
   */
  registerAll?: boolean;
  /**
   * Where the emitted routes import their mount helpers from. Absent: the adapter copy
   * `meta eject routes` placed in `codegen/runtime/`, by a path computed from the target's
   * output directory. A relative value is relative to the output root (like `dbImport`);
   * `"@metaobjectsdev/runtime-ts"` imports the package instead.
   */
  runtimeImport?: string;
  target?: string;
}

export const routesFile = function routesFile(opts?: RoutesFileOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const emitEntities = perEntity(async (entity, ctx) => {
    if (!ctx.renderContext) {
      throw new Error("routes-file: renderContext is required (provided by runGen)");
    }
    const renderContext: RenderContext = {
      ...ctx.renderContext,
      httpRuntimeImport: opts?.runtimeImport
        ?? ownedRuntimeImport(ctx.projectRoot ?? ".", ctx.renderContext.selfTarget.outDir),
    };
    return {
      path: entityOutputPath(ctx.config.outputLayout ?? "flat", effectivePackage(entity), `${entity.name}.routes.ts`),
      content: await formatTs(renderRoutes(entity, renderContext, resolveExpose(entity, opts?.expose))),
    };
  });
  const generator: Generator = {
    name: "routes-file",
    // TPH subtypes get no standalone routes file (their routes live in the discriminator
    // base's); AND-composed with your filter.
    // #248 R2: an object with no declared/inherited source.rdb (of ANY kind) isn't
    // backed by any store — routes against it would import Drizzle table/allowlist
    // exports the entity file never emits. Gated by servesReadApi, which also skips
    // abstract objects: an abstract level has no table of its own to mount.
    filter: (e: MetaObject) =>
      servesReadApi(e) && !isTphSubtype(e) && userFilter(e),
    generate: async (ctx) => {
      const files = await emitEntities(ctx);
      if (!opts?.registerAll) return files;
      const matched = ctx.entities.filter(ctx.matches);
      if (matched.length === 0 || !ctx.renderContext) return files;
      return [...files, {
        path: routesIndexFileName("fastify"),
        content: await formatTs(renderRoutesIndex(matched, ctx.renderContext, "fastify")),
      }];
    },
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<RoutesFileOpts>;
