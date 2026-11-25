// Fastify route template — emits a per-entity routes file that delegates
// CRUD verbs to helpers from @metaobjectsdev/runtime-ts/drizzle-fastify.
//
// Dispatch logic:
//   isProjection(entity)  → mountReadOnlyCrudRoutes (GET list + GET :id; GET list alone
//                           for a keyless projection or a served report, FR-044)
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

import type { Code } from "@metaobjectsdev/codegen-ts/engine";
import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  TYPE_FIELD,
  resolveColumnName,
} from "@metaobjectsdev/metadata";
import { type RenderContext } from "@metaobjectsdev/codegen-ts/engine";
import { crossEntitySpecifier, entityModuleSpecifier, relativeModuleSpecifier, siblingSpecifier } from "@metaobjectsdev/codegen-ts/engine";
import { namesRef, columnExpr } from "@metaobjectsdev/codegen-ts/engine";
import { GENERATED_HEADER, GENERATED_EDIT_NOTE, sidecarComment } from "@metaobjectsdev/codegen-ts/engine";
import { routesHandlerName } from "@metaobjectsdev/codegen-ts/engine";
import { isProjection, isWriteThrough } from "@metaobjectsdev/codegen-ts/engine";
import { isReport } from "@metaobjectsdev/codegen-ts/engine";
import {
  decimalColumnsMembers,
  itemRouteField,
  knownFieldsMembers,
  paginationMembers,
  readOnlyMountMembers,
  writeDeniedColumnsMembers,
} from "@metaobjectsdev/codegen-ts/engine";
import { pkInfoOf } from "@metaobjectsdev/codegen-ts/engine";
import type { RelationEntry } from "@metaobjectsdev/codegen-ts/engine";
import { isTphDiscriminatorBase, tphPlan } from "./tph-discriminator.js";
import { hasInsertRefinements } from "./zod-validators.js";
import { authSeamDoc, type CrudVerb, exposeMembers, intersectExpose, TPH_POLYMORPHIC_VERBS } from "@metaobjectsdev/codegen-ts/engine";
import { effectivePackage } from "@metaobjectsdev/codegen-ts/engine";
import { tphDiscriminatorPin, tphStorageObject } from "@metaobjectsdev/codegen-ts/engine";
import { httpRuntimeSpecifier } from "@metaobjectsdev/codegen-ts/engine";
import { str, TsWriter } from "@metaobjectsdev/codegen-ts/engine";

type M2mEntry = RelationEntry & { junctionEntity: string; junction: MetaObject };

export function renderRoutesFile(
  entity: MetaObject,
  ctx: RenderContext,
  // #348 — resolved by the generator from its `expose` option. undefined = all five verbs,
  // which emits no `expose` key at all and so keeps output byte-identical for projects
  // that do not use it.
  expose?: readonly CrudVerb[],
  // Row cap of a served report (`routesFile({ reportMaxRows })`). undefined emits no key.
  reportMaxRows?: number,
): string {
  const w = new TsWriter();
  writeRoutesFile(w, entity, ctx, expose, reportMaxRows);
  return w.toString();
}

/** Write {@link renderRoutesFile}'s module, header included, into `w`. */
export function writeRoutesFile(
  w: TsWriter,
  entity: MetaObject,
  ctx: RenderContext,
  expose?: readonly CrudVerb[],
  reportMaxRows?: number,
): void {
  // FR-017 Tier 2 — a TPH discriminator base mounts polymorphic list/get at the
  // base path plus a full per-subtype CRUD route set scoped to each
  // discriminator value. (Subtype entities are filtered out of the routes
  // generator entirely — their routes live here.)
  if (isTphDiscriminatorBase(entity, ctx.loadedRoot)) {
    writeTphRoutesFile(w, entity, ctx, expose);
    return;
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
  const fromEntity = (name: string): string => w.use(name, entityFileSpec);

  w.header(
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${entityName} (${entity.fqn()})`,
    sidecarComment(`${entityName}.extra.ts`),
  );
  w.use("db", relativeModuleSpecifier(ctx.outputLayout, entityPkg, ctx.dbImport, ctx.extStyle));
  const fastifyType = w.useType("FastifyInstance", "fastify");

  // Where the mount helpers come from: the package, or an owned copy (owned-runtime.ts).
  const runtimeSpec = httpRuntimeSpecifier("drizzle-fastify", ctx, entityPkg);
  const camelName = entityName.charAt(0).toLowerCase() + entityName.slice(1);

  // --- Projection / report path: read-only routes (GET list, + GET :id when keyed) ---
  if (isProjection(entity)) {
    const report = isReport(entity);
    const noun = report ? "report" : "projection";
    // A keyless read-only object (a projection with no identity and no `id` column, and
    // every report: FR-044) has no row to address, so it mounts GET list and the collection 405
    // and no `/:id` route of any verb.
    const exposes = itemRouteField(entity) === undefined
      ? "Exposes GET list only. POST returns 405."
      : "Exposes GET list + GET :id only. POST/PATCH/DELETE return 405.";
    const constRef = fromEntity(entityName);
    const viewRef = fromEntity(`${camelName}View`);
    const filterRef = fromEntity(`${entityName}FilterAllowlist`);
    const sortRef = fromEntity(`${entityName}SortAllowlist`);
    // The report-export generator is wired for this target: mount its `?format=` branch with the
    // module it emitted beside this file. Absent, the file is byte-identical to before export existed.
    const exportRef = report && ctx.includeReportExport
      ? w.use(`${entityName}Export`, siblingSpecifier(ctx.selfTarget, entityPkg, `${entityName}.export`, ctx.extStyle))
      : undefined;
    const mount = w.use("mountReadOnlyCrudRoutes", runtimeSpec);
    w.doc(
      `Mount read-only REST endpoints for ${entityName} (${noun} — view-backed, no writes).`,
      "",
      exposes,
      "Customize: register this as-is, or import individual route helpers from",
      `${runtimeSpec}.`,
      // A projection mount is read-only by construction, so `expose` cannot narrow it —
      // the paragraph drops the narrowing advice and keeps the auth seam.
      ...authSeamDoc({ framework: "fastify", handlerName, narrowable: false }),
    );
    writeHandler(w, ctx, handlerName, fastifyType, (fastify) => {
      writeMount(w, mount, [
        fastify === "fastify" ? "fastify," : `fastify: ${fastify},`,
        `path: ${constRef}.$path,`,
        "db,",
        `view: ${viewRef},`,
        `filterAllowlist: ${filterRef},`,
        `sortAllowlist: ${sortRef},`,
        `dialect: ${str(ctx.dialect)},`,
        ...readOnlyMountMembers(entity, ctx.loadedRoot, { reportMaxRows, exportRef }),
      ]);
    });
    return;
  }

  // --- Vanilla / write-through entity path: full CRUD routes ---
  // #214 — a write-through entity (writable table + replica @kind:view + derived
  // origin.passthrough fields) keeps FULL CRUD (writes → table) but its READS must
  // route through the replica view so the HTTP responses carry the derived field.
  // The entity file already exports `<camel>View` as an `.existing()` Drizzle view;
  // import it and pass it as `readView` to mountCrudRoutes. A vanilla entity omits both.
  const constRef = fromEntity(entityName);
  const tableRef = fromEntity(ctx.collectionName(entityName));
  const readView = isWriteThrough(entity) ? [`readView: ${fromEntity(`${camelName}View`)},`] : [];
  const insertRef = fromEntity(`${entityName}InsertSchema`);
  const updateRef = fromEntity(`${entityName}UpdateSchema`);
  const filterRef = fromEntity(`${entityName}FilterAllowlist`);
  const sortRef = fromEntity(`${entityName}SortAllowlist`);
  const mount = w.use("mountCrudRoutes", runtimeSpec);

  // FR-018 M:N traversal: for each many-to-many navigation declared on this
  // entity, emit a mountM2mRoute(...) that traverses the junction. The junction
  // FK columns were derived from the junction's identity.reference children (the
  // SSOT) by the relation-resolver pre-pass; here we resolve them to physical
  // column names for the Drizzle two-stage join.
  const m2mEntries = m2mEntriesOf(ctx, entityName);

  w.doc(
    `Mount the 5 standard REST endpoints for ${entityName} using Drizzle directly.`,
    "",
    "Customize: register this as-is for stock CRUD, OR import the per-verb",
    "helpers (mountListRoute, mountGetRoute, ...) from",
    `${runtimeSpec} and mix with your own handlers`,
    "(auth, side effects, etc.).",
    ...authSeamDoc({ framework: "fastify", handlerName, narrowable: true }),
  );
  writeHandler(w, ctx, handlerName, fastifyType, (fastify) => {
    writeMount(w, mount, [
      fastify === "fastify" ? "fastify," : `fastify: ${fastify},`,
      `path: ${constRef}.$path,`,
      "db,",
      `table: ${tableRef},`,
      ...readView,
      `insertSchema: ${insertRef},`,
      `updateSchema: ${updateRef},`,
      `filterAllowlist: ${filterRef},`,
      `sortAllowlist: ${sortRef},`,
      `dialect: ${str(ctx.dialect)},`,
      ...decimalColumnsMembers(entity, ctx.loadedRoot),
      ...writeDeniedColumnsMembers(entity),
      ...knownFieldsMembers(entity, ctx.loadedRoot),
      ...paginationMembers(entity, ctx.loadedRoot),
      ...exposeMembers(expose),
    ]);
    // Under an apiPrefix the mounts live inside the register-block (`instance`); otherwise
    // they bind directly to `fastify`.
    writeM2mMounts(w, m2mEntries, entity, ctx, fastify);
  });
}

/** `fn({ ...members })`: one member per line. */
function writeMount(w: TsWriter, fn: string, members: readonly unknown[]): void {
  w.block(`${fn}({`, () => {
    for (const m of members) w.line(m);
  }, "});");
}

/**
 * The exported handler. Under an `apiPrefix` its mounts are wrapped in
 * `fastify.register(..., { prefix })` and bind to `instance`; `body` is told which.
 */
function writeHandler(
  w: TsWriter,
  ctx: RenderContext,
  handlerName: string,
  fastifyType: string,
  body: (fastify: string) => void,
): void {
  w.block(`export async function ${handlerName}(fastify: ${fastifyType}) {`, () => {
    if (ctx.apiPrefix) {
      w.block("await fastify.register(async (instance) => {", () => body("instance"), `}, { prefix: ${str(ctx.apiPrefix)} });`);
    } else {
      body("fastify");
    }
  });
}

/**
 * The M:N navigation entries of `name` — the ONE rule for which relationships get a
 * traversal mount. The vanilla entity path and the TPH path both go through it, so
 * they cannot drift apart: a rule change moves every mount at once, and the
 * independent oracle's route rule stays checkable against both emit paths alike.
 */
function m2mEntriesOf(ctx: RenderContext, name: string): M2mEntry[] {
  return (ctx.relationMap.get(name) ?? []).filter(
    (e): e is M2mEntry => e.junctionEntity !== undefined && e.junction !== undefined,
  );
}

/**
 * Write the M:N traversal mounts for an entity, one `mountM2mRoute(...)` each. `fastifyVar`
 * is the in-scope Fastify reference (`instance` under an apiPrefix register-block, else
 * `fastify`). Writes nothing when the entity has no M:N relationships; `separate` sets a
 * non-empty group off from the mount before it with a blank line.
 */
function writeM2mMounts(
  w: TsWriter,
  entries: readonly M2mEntry[],
  source: MetaObject,
  ctx: RenderContext,
  fastifyVar: string,
  opts: { separate?: boolean; tphSource?: TphM2mSource } = {},
): void {
  if (opts.separate === true && entries.length > 0) w.blank();
  for (const e of entries) writeM2mMount(w, e, source, ctx, fastifyVar, opts.tphSource);
}

/**
 * Where a TPH M:N mount hangs, and how it proves the source id is really ITS subtype's.
 *
 * Only `writeTphRoutesFile` supplies this, and only for a relationship declared ON a
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
  table: string;
  /** Physical PK column of the base table. */
  pkColumn: Code | string;
  /** Physical discriminator column of the base table. */
  discriminatorColumn: Code | string;
  /** This subtype's `@discriminatorValue`. */
  value: string;
}

/**
 * The object a M:N mount reads rows of, plus the subtypes of a TPH base target: its rows are
 * shared-table rows of every subtype, so a credential declared by any of them is hidden too.
 */
function m2mTargetObjects(target: MetaObject, ctx: RenderContext): MetaObject[] {
  const plan = ctx.loadedRoot === undefined ? null : tphPlan(target, ctx.loadedRoot);
  return plan === null ? [target] : [target, ...plan.subtypes.map((st) => st.entity)];
}

/**
 * Write one M:N traversal mount. The junction + target Drizzle table consts are
 * imported from their sibling entity files. The source/target FK columns + the target PK
 * are resolved to PHYSICAL column names via resolveColumnName (the runtime two-stage join
 * queries by column). mountM2mRoute appends `/:id/<relationName>` to the source $path.
 */
function writeM2mMount(
  w: TsWriter,
  entry: M2mEntry,
  source: MetaObject,
  ctx: RenderContext,
  fastifyVar: string,
  tphSource?: TphM2mSource,
): void {
  // `source` never changes across this function, so its effective package is computed
  // once and reused below (both crossEntitySpecifier calls, and the three
  // resolveJunctionColumn calls' `fromPackage` — see that comment for why it must be
  // SOURCE's package rather than the junction/target entity's own).
  const sourcePkg = effectivePackage(source);
  const junctionTable = w.use(
    ctx.collectionName(entry.junctionEntity),
    crossEntitySpecifier(ctx.outputLayout, sourcePkg, effectivePackage(entry.junction), entry.junctionEntity, ctx.extStyle),
  );
  // An M:N onto a TPH subtype traverses into its discriminator BASE's table — the
  // subtype has no table const, and the junction FK can only point at the base table —
  // and filters the rows to the subtype, because a Broker id in that FK column is not a
  // Carrier. Every other target binds to itself, and emits no filter.
  const target = tphStorageObject(entry.target);
  const pin = tphDiscriminatorPin(entry.target);
  // A self-join's target table IS the source table, which this file already imports from
  // the entity module; a second import of the same binding is TS2300, and a SyntaxError
  // when Node loads the module.
  const targetTable = target === source
    ? ctx.collectionName(source.name)
    : w.use(
      ctx.collectionName(target.name),
      crossEntitySpecifier(ctx.outputLayout, sourcePkg, effectivePackage(target), target.name, ctx.extStyle),
    );
  const mount = w.use("mountM2mRoute", httpRuntimeSpecifier("drizzle-fastify", ctx, sourcePkg));
  const junction = entry.junction;
  // The relation-resolver pre-pass derives both join fields for every M:N entry.
  const { sourceJoinField, targetJoinField } = entry;
  if (sourceJoinField === undefined || targetJoinField === undefined) {
    throw new Error(`routes-file: M:N "${entry.name}" on ${source.name} has no derived join fields`);
  }
  // fromPackage = source.package: this routes file is SOURCE's own module, never the
  // junction's or the target's — see resolveJunctionColumn's doc comment (B1).
  const sourceColumn = resolveJunctionColumn(junction, sourceJoinField, ctx, sourcePkg);
  const targetColumn = resolveJunctionColumn(junction, targetJoinField, ctx, sourcePkg);
  const targetPkColumn = resolveJunctionColumn(target, pkInfoOf(target)?.fieldName ?? "id", ctx, sourcePkg);

  // A subtype-declared M:N hangs under the subtype's segment; everything else hangs at
  // the source entity's own path. `$path` is read from the BASE const either way — a TPH
  // subtype's module exports no entity const of its own.
  const path = tphSource === undefined
    ? `${source.name}.$path`
    : `${source.name}.$path + ${str(tphSource.pathSuffix)}`;
  writeMount(w, mount, [
    `fastify: ${fastifyVar},`,
    `path: ${path},`,
    `relationName: ${str(entry.name)},`,
    "db,",
    `junctionTable: ${junctionTable},`,
    `targetTable: ${targetTable},`,
    ["sourceColumn: ", sourceColumn, ","],
    ["targetColumn: ", targetColumn, ","],
    ["targetPkColumn: ", targetPkColumn, ","],
    `symmetric: ${entry.symmetric ? "true" : "false"},`,
    ...decimalColumnsMembers(m2mTargetObjects(entry.target, ctx), ctx.loadedRoot),
    ...(pin !== undefined
      ? [["targetDiscriminator: { column: ", resolveJunctionColumn(target, pin.fieldName, ctx, sourcePkg), `, value: ${str(pin.value)} },`]]
      : []),
    ...(tphSource !== undefined
      ? [[
        `sourceDiscriminator: { table: ${tphSource.table}, pkColumn: `, tphSource.pkColumn,
        ", column: ", tphSource.discriminatorColumn, `, value: ${str(tphSource.value)} },`,
      ]]
      : []),
  ]);
}

/**
 * Resolve a field's physical column name on an entity (defaults if missing), as a
 * `Code` fragment (its `<Entity>Names` import is collected where it is written).
 *
 * §A6/§B2 — references `<Entity>Names.fields.<field>.column` whenever the names
 * artifact is in this run AND carries the field (the same two-condition shape as every
 * other §A6 site: is the artifact in the run, is the field in it — both PRESENCE
 * guards). A literal otherwise.
 *
 * B1 — `entity` here is the JUNCTION or TARGET object, never the routes file's own
 * SOURCE entity (see writeM2mMount) — so `fromPackage` MUST be the source entity's
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
): Code | string {
  // ADR-0039: resolving — a junction FK field may be inherited via extends.
  const field = entity.children().find((c) => c.type === TYPE_FIELD && c.name === fieldName);
  if (!field) return str(fieldName);
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
function writeTphRoutesFile(
  w: TsWriter,
  base: MetaObject,
  ctx: RenderContext,
  expose?: readonly CrudVerb[],
): void {
  const baseName = base.name;
  const handlerName = routesHandlerName(baseName);
  // Single source of truth for the discriminator field + subtypes + route segments.
  const plan = tphPlan(base, ctx.loadedRoot);
  if (plan === null) {
    throw new Error(`routes-file: ${baseName} is not a TPH discriminator base`);
  }
  const discField = plan.discriminatorField;

  const basePkg = effectivePackage(base);
  const baseFileSpec = entityModuleSpecifier(
    ctx.selfTarget, ctx.entityModuleTarget, basePkg, baseName, ctx.extStyle,
  );
  w.header(
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${baseName} (${base.fqn()}) — TPH discriminator base`,
    sidecarComment(`${baseName}.extra.ts`),
  );
  const fastifyType = w.useType("FastifyInstance", "fastify");
  const mount = w.use("mountCrudRoutes", httpRuntimeSpecifier("drizzle-fastify", ctx, basePkg));
  const db = w.use("db", relativeModuleSpecifier(ctx.outputLayout, basePkg, ctx.dbImport, ctx.extStyle));
  const fromBase = (name: string): string => w.use(name, baseFileSpec);
  const table = fromBase(ctx.collectionName(baseName));
  const baseConst = fromBase(baseName);
  const dialect = `dialect: ${str(ctx.dialect)},`;
  const hierarchy = [base, ...plan.subtypes.map((st) => st.entity)];

  // FR-018 x FR-017 — M:N traversal inside a TPH hierarchy. This file never consulted
  // the relation map at all, so BOTH sides vanished from the generated API: a
  // relationship declared on the base (every row of the table is a legitimate source)
  // and one declared on a subtype (only that subtype's rows are). Neither is a compile
  // error — a route that is never mounted is an absence — which is why the codegen
  // compile gate stayed green while the endpoint 404'd.
  //
  // The physical columns stage 0 needs, resolved once against the base's own table.
  const basePkColumn = resolveJunctionColumn(base, pkInfoOf(base)?.fieldName ?? "id", ctx, basePkg);
  const baseDiscColumn = resolveJunctionColumn(base, discField, ctx, basePkg);

  w.doc(
    `Mount polymorphic + per-subtype REST endpoints for the ${baseName} TPH hierarchy.`,
    "",
    `GET ${baseName}.$path (+ /:id) lists/gets the discriminated union; each`,
    `/${baseName}.$path/<subtype> path is a full per-subtype CRUD set.`,
    // The base path is read-only by construction (TPH_POLYMORPHIC_VERBS), but the
    // per-subtype mounts below it are full CRUD — so `expose` does narrow this file.
    ...authSeamDoc({ framework: "fastify", handlerName, narrowable: true }),
  );
  writeHandler(w, ctx, handlerName, fastifyType, (fastify) => {
    // The polymorphic mount is read-only BY CONSTRUCTION — the discriminated union has no
    // single writable shape — so an author-supplied `expose` intersects with that fixed set
    // rather than replacing it: it may narrow to just `list`, never widen to `create`.
    writeMount(w, mount, [
      `fastify: ${fastify},`,
      `path: ${baseConst}.$path,`,
      `db: ${db},`,
      `table: ${table},`,
      `insertSchema: ${fromBase(`${baseName}InsertSchema`)},`,
      `updateSchema: ${fromBase(`${baseName}UpdateSchema`)},`,
      `filterAllowlist: ${fromBase(`${baseName}FilterAllowlist`)},`,
      `sortAllowlist: ${fromBase(`${baseName}SortAllowlist`)},`,
      dialect,
      ...decimalColumnsMembers(hierarchy, ctx.loadedRoot),
      ...paginationMembers(base, ctx.loadedRoot),
      ...exposeMembers(intersectExpose([...TPH_POLYMORPHIC_VERBS], expose)),
    ]);
    writeM2mMounts(w, m2mEntriesOf(ctx, baseName), base, ctx, fastify, { separate: true });

    for (const { entity: sub, value, routeSegment: segment } of plan.subtypes) {
      const subFileSpec = entityModuleSpecifier(
        ctx.selfTarget, ctx.entityModuleTarget, effectivePackage(sub), sub.name, ctx.extStyle,
      );
      const fromSub = (name: string): string => w.use(name, subFileSpec);
      // A subtype with cross-field rules has a refined InsertSchema, which Zod will not
      // `.omit()`; its codegen exports the discriminator-less refined body instead.
      const insertBody = hasInsertRefinements(sub)
        ? fromSub(`${sub.name}InsertBodySchema`)
        : `${fromSub(`${sub.name}InsertSchema`)}.omit({ ${discField}: true })`;
      // FR-036 Program B: the per-subtype UPDATE must carry the FR-035 present-key
      // tristate (a non-@required subtype column accepts an explicit null → clears;
      // a @required column's explicit null is rejected). The subtype's own
      // UpdateSchema encodes exactly that (.optional() + .nullable() for non-required),
      // whereas insertSchema.partial() only makes fields optional, not nullable — so a
      // PATCH {col: null} on a nullable subtype column wrongly 400'd. The base
      // polymorphic mount already uses the base UpdateSchema; this aligns the subtypes.
      // FR-017 Tier 3: each subtype carries its OWN filter/sort allowlist
      // (discriminator excluded — it's pinned by this path).
      w.blank();
      writeMount(w, mount, [
        `fastify: ${fastify},`,
        `path: ${baseConst}.$path + ${str(`/${segment}`)},`,
        `db: ${db},`,
        `table: ${table},`,
        `insertSchema: ${insertBody},`,
        `updateSchema: ${fromSub(`${sub.name}UpdateSchema`)},`,
        `filterAllowlist: ${fromSub(`${sub.name}FilterAllowlist`)},`,
        `sortAllowlist: ${fromSub(`${sub.name}SortAllowlist`)},`,
        dialect,
        ...decimalColumnsMembers(sub, ctx.loadedRoot, hierarchy),
        ...writeDeniedColumnsMembers(sub, hierarchy),
        ...knownFieldsMembers(sub, ctx.loadedRoot, hierarchy),
        ...paginationMembers(sub, ctx.loadedRoot),
        `discriminator: { column: ${str(discField)}, value: ${str(value)} },`,
        ...exposeMembers(expose),
      ]);
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
      // `/auths/bridge/1/tags` answers [] for a Coupon id — the segment is a type
      // assertion, which is exactly what sourceDiscriminator enforces below.
      writeM2mMounts(w, m2mEntriesOf(ctx, sub.name), base, ctx, fastify, {
        separate: true,
        tphSource: { pathSuffix: `/${segment}`, table, pkColumn: basePkColumn, discriminatorColumn: baseDiscColumn, value },
      });
    }
  });
}
