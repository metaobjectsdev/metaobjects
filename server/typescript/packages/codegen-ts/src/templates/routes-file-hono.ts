// Hono route template — emits a per-entity routes file that delegates
// CRUD verbs to helpers from @metaobjectsdev/runtime-ts/hono.
//
// Hono parallel of templates/routes-file.ts. Two emit-shape differences
// vs the Fastify flavor, both reflecting Hono idioms rather than contract
// drift:
//
//   1) Exported function shape — `registerXxxRoutes(app, deps)` instead of
//      `xxxRoutes(fastify)`. Workers/Bun consumers typically pass `db`
//      through a per-request deps object (so a Worker can attach the
//      D1 client pulled off bindings) rather than reaching for a
//      module-level singleton. The Fastify flavor uses `import { db }`
//      because Fastify apps are long-lived Node processes where a
//      singleton is the norm. Both flavors talk to mountCrudRoutes /
//      mountReadOnlyCrudRoutes with identical wire behavior.
//
//   2) apiPrefix is composed into the resource path (`${apiPrefix}${path}`)
//      rather than wrapping the registration. Hono has no fastify.register
//      / prefix-wrapping primitive; sub-apps via `app.route(prefix, sub)`
//      exist but bloat the generated code. String concat is simpler and
//      produces identical URL grammar.
//
// Dispatch logic mirrors Fastify:
//   isProjection(entity)              → mountReadOnlyCrudRoutes (GET list + GET :id)
//   vanilla / write-through entity    → mountCrudRoutes (all 5 CRUD verbs)

import type { MetaObject } from "@metaobjectsdev/metadata";
import { type RenderContext } from "../render-context.js";
import { entityModuleSpecifier, siblingSpecifier } from "../import-path.js";
import { GENERATED_HEADER, GENERATED_EDIT_NOTE, sidecarComment } from "../constants.js";
import { isProjection, isWriteThrough } from "../projection/projection-detector.js";
import { isReport } from "../source-detect.js";
import {
  decimalColumnsMembers,
  itemRouteField,
  knownFieldsMembers,
  paginationMembers,
  readOnlyMountMembers,
  writeDeniedColumnsMembers,
} from "../api-surface.js";
import { authSeamDoc, type CrudVerb, exposeMembers } from "../routes-expose.js";
import { effectivePackage } from "../docs-paths.js";
import { httpRuntimeSpecifier } from "../owned-runtime.js";
import { str, TsWriter } from "../writer/ts-writer.js";

export function renderRoutesFileHono(
  entity: MetaObject,
  ctx: RenderContext,
  // #348 — resolved by the generator from its `expose` option. undefined = all five verbs,
  // emitting no `expose` key at all, so output stays byte-identical without it.
  //
  // Applies to the CRUD mount only. The projection branch uses
  // mountReadOnlyCrudRoutes, a different helper that is read-only by construction and
  // takes no `expose` — there is no writable surface there to narrow.
  expose?: readonly CrudVerb[],
  // Row cap of a served report (`routesFile({ reportMaxRows })`). undefined emits no key.
  reportMaxRows?: number,
): string {
  const w = new TsWriter();
  writeRoutesFileHono(w, entity, ctx, expose, reportMaxRows);
  return w.toString();
}

/** Write {@link renderRoutesFileHono}'s module, header included, into `w`. */
export function writeRoutesFileHono(
  w: TsWriter,
  entity: MetaObject,
  ctx: RenderContext,
  expose?: readonly CrudVerb[],
  reportMaxRows?: number,
): void {
  const entityName = entity.name;
  const handlerName = `register${entityName}Routes`;
  const entityPkg = effectivePackage(entity);
  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    entityPkg,
    entityName,
    ctx.extStyle,
  );
  const fromEntity = (name: string): string => w.use(name, entityFileSpec);

  // Where the mount helpers come from: the package, or an owned copy (owned-runtime.ts).
  const runtimeSpec = httpRuntimeSpecifier("hono", ctx, entityPkg);

  w.header(
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${entityName} (${entity.fqn()})`,
    sidecarComment(`${entityName}.extra.ts`),
  );
  const hono = w.useType("Hono", "hono");
  const constRef = fromEntity(entityName);
  const camelName = entityName.charAt(0).toLowerCase() + entityName.slice(1);

  // Path composition: apiPrefix is a literal string in the URL.
  const pathExpr = ctx.apiPrefix
    ? `\`${ctx.apiPrefix}\${${constRef}.$path}\``
    : `${constRef}.$path`;
  // The same path with Hono's trailing wildcard, for the auth recipe in the JSDoc.
  // `"/users/*"` matches `/users` itself, so one app.use covers list, get and writes.
  const authPathExpr = ctx.apiPrefix
    ? `\`${ctx.apiPrefix}\${${constRef}.$path}/*\``
    : `\`\${${constRef}.$path}/*\``;

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
      ...authSeamDoc({ framework: "hono", handlerName, mountPathExpr: authPathExpr, narrowable: false }),
    );
    writeHandler(w, handlerName, hono, mount, [
      "app,",
      `path: ${pathExpr},`,
      "db: deps.db,",
      `view: ${viewRef},`,
      `filterAllowlist: ${filterRef},`,
      `sortAllowlist: ${sortRef},`,
      `dialect: ${str(ctx.dialect)},`,
      ...readOnlyMountMembers(entity, ctx.loadedRoot, { reportMaxRows, exportRef }),
    ]);
    return;
  }

  // --- Vanilla / write-through entity path: full CRUD routes ---
  // #214: a write-through entity reads through its replica view so derived origin.*
  // columns are present. Without this the Hono adapter returned rows missing every
  // derived field the generated type and Zod schema promise, and a filter or sort on
  // one — both ALLOWED by the generated allowlists — hit a column the table does not
  // have, producing a 500. Fastify has done this since #214; Hono was simply never
  // wired, exactly as it was never wired for #286's `.all()`/`.get()` fix.
  const tableRef = fromEntity(ctx.collectionName(entityName));
  const insertRef = fromEntity(`${entityName}InsertSchema`);
  const updateRef = fromEntity(`${entityName}UpdateSchema`);
  const filterRef = fromEntity(`${entityName}FilterAllowlist`);
  const sortRef = fromEntity(`${entityName}SortAllowlist`);
  const readView = isWriteThrough(entity) ? [`readView: ${fromEntity(`${camelName}View`)},`] : [];
  const mount = w.use("mountCrudRoutes", runtimeSpec);
  w.doc(
    `Mount the 5 standard REST endpoints for ${entityName} using Drizzle directly.`,
    "",
    "Customize: register this as-is for stock CRUD, OR import the per-verb",
    "helpers (mountListRoute, mountGetRoute, ...) from",
    `${runtimeSpec} and mix with your own handlers`,
    "(auth, side effects, etc.).",
    ...authSeamDoc({ framework: "hono", handlerName, mountPathExpr: authPathExpr, narrowable: true }),
  );
  writeHandler(w, handlerName, hono, mount, [
    "app,",
    `path: ${pathExpr},`,
    "db: deps.db,",
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
}

/** `export function register<Entity>Routes(app, deps)`, whose body is the one mount call. */
function writeHandler(w: TsWriter, handlerName: string, hono: string, mount: string, members: readonly string[]): void {
  w.block(`export function ${handlerName}(app: ${hono}<any, any, any>, deps: { db: unknown }): void {`, () => {
    w.block(`${mount}({`, () => {
      for (const m of members) w.line(m);
    }, "});");
  });
}
