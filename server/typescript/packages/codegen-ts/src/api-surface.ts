// Does this object have a generated HTTP API surface?
//
// THIS is the question the UI tier should ask. A hook, a grid and a form are all
// clients of a REST endpoint: hooks fetch one, a grid renders what a hook returned,
// a form submits to one. None of them knows or cares where the data is stored — that
// is the whole point of the architecture, and `@metaobjectsdev/runtime-web` is
// deliberately browser-only with no database dependency at all.
//
// The UI generators used to ask `hasAnyRdbSource` directly, which produced the RIGHT
// answer for the WRONG reason: routes are currently derived from sources (FR-008/009
// derived CRUD), so "has a relational source" and "has an endpoint" happen to
// coincide today. They are not the same question, and the coincidence is temporary —
// FR-024 declared `api.*` surfaces and #211 non-RDB projection materialization both
// break it, at which point a UI tier reaching through to storage starts refusing to
// generate hooks for entities that genuinely do have endpoints.
//
// So the reach-through lives in exactly one place now, named for what it means. When
// route derivation grows a second source of truth, this function changes and every
// UI generator follows for free.
//
// Two questions since FR-044 Plan 3: `servesReadApi` asks whether a read endpoint exists
// (the route and queries generators), and `servesClientTier` asks whether the client UI
// tier is generated for it (hooks, grids, `agent/ui.md`). They differ for a served
// report, which has a route and no UI tier until Plan 5.

import type { MetaObject } from "@metaobjectsdev/metadata";
import { isAbstract } from "./instance-artifacts.js";
import { isProjection } from "./projection/projection-detector.js";
import { hasAnyRdbSource, hasWritableRdbSource, isReport, servedReport } from "./source-detect.js";
import { getPkFields } from "./templates/queries.js";
import { resourcePath, restPath } from "./templates/entity-ui-descriptor.js";
import {
  declaresTphDiscriminator,
  isTphSubtype,
  tphDiscriminatorBase,
  tphDiscriminatorPin,
} from "./templates/zod-validators.js";
import { tphRouteSegment } from "./templates/tph-discriminator.js";

/**
 * True when the object is served by a generated READ endpoint.
 *
 * Abstract types are excluded (no instance to address). Today the endpoint test is
 * "declares or inherits a `source.rdb`", which is precisely the predicate
 * `routesFile` / `routesFileHono` gate on. The UI tier asks `servesClientTier`, which
 * is this answer minus reports.
 */
export function servesReadApi(entity: MetaObject): boolean {
  // FR-044 Plan 3: a report is served exactly when Table A says so (`servedReport`: not
  // abstract, read source `@kind: view`). The question is asked of the declared report
  // node by the doors that read the model directly (docs, owned generators) and of its
  // read model by the generators `runGen` drives; both answer the same. A report whose
  // read-only source is any other kind passes the source test below and is served by
  // nothing, so a report never reaches that test.
  if (isReport(entity)) return servedReport(entity);
  return !isAbstract(entity) && hasAnyRdbSource(entity);
}

/**
 * True when the read-only surface of the object has `/:id` routes, a by-id query and a
 * detail hook: the object declares a primary identity, and the column it names is a field
 * of the object.
 *
 * - A report (the declared node or its read model) never has one, even when a derived
 *   field happens to be named `id`: a report has no identity, and its rows are groups.
 * - A projection with no declared primary identity has none either, even when it has a
 *   field named `id`. There is no declared key to address a row by, and "a field called
 *   `id`" is a convention, not a key. This is the JVM and C# rule
 *   (`RestSurfaceGate.hasItemRoute`), and the rule of the cross-port `projection/` corpus.
 * - A composite identity answers true: its by-id query reads the first component.
 *
 * Only the read-only templates ask. The writable surface emits item routes unconditionally.
 */
export function hasItemRoute(entity: MetaObject): boolean {
  return itemRouteField(entity) !== undefined;
}

/**
 * The field a read-only object's item routes address a row by, or `undefined` when it has
 * none (`hasItemRoute` is exactly "this is defined"). It is `getPkInfo`'s field, so the
 * by-id query and the mounted `GET /:id` read the same column.
 *
 * The read-only mount addresses `id` unless told otherwise, so a routes template passes
 * this as the mount's `idColumn` whenever it is not `id`. Without that, a projection keyed
 * on `code` mounted a `/:id` route that compared nothing and answered with the view's
 * first row.
 */
export function itemRouteField(entity: MetaObject): string | undefined {
  if (isReport(entity)) return undefined;
  // ADR-0039: resolving. `getPkFields` reads `primaryIdentity()` and `findField` reads
  // `fields()`, both of which walk the super chain; a projection's identity and its key
  // field are typically inherited from its base entity.
  const idField = getPkFields(entity)[0];
  return idField !== undefined && entity.findField(idField) !== undefined ? idField : undefined;
}

/**
 * True when the client UI tier (hooks, grids, `agent/ui.md`) is generated for the
 * object: `servesReadApi(entity)` and not a report. A served report has a route and no
 * UI tier until Plan 5.
 */
export function servesClientTier(entity: MetaObject): boolean {
  return servesReadApi(entity) && !isReport(entity);
}

/**
 * True when the object is served by generated WRITE endpoints — so a form has
 * somewhere to submit. Requires a WRITABLE source: the same predicate the entity-file
 * generator uses to decide whether `Insert`/`Update` schemas exist at all, so a form
 * can never be emitted against schemas that were never generated.
 */
export function servesWriteApi(entity: MetaObject): boolean {
  return !isAbstract(entity) && hasWritableRdbSource(entity);
}

// `restPath` MOVED to templates/entity-ui-descriptor.ts, beside `resourcePath` and the
// descriptor that emits `$path` from it. Re-exported here because this module is where
// the package barrel and `generators/agent-ui-page.ts` import it from, and neither should
// have to care that the composition moved.
export { restPath } from "./templates/entity-ui-descriptor.js";

/**
 * The address the generated routes actually SERVE an object at: the mount prefix plus the
 * object's REST path.
 *
 * One function, because getting this wrong is the defect it exists to prevent, twice over.
 * `agent/ui.md` documented `/authors` for routes mounted at `/api/authors`; the API
 * reference did the same, separately, in two more places — three doors composing one
 * address, each free to drift from the others. `templates/routes-file-hono.ts` and
 * `routes-file.ts` compose the same thing into GENERATED code and remain the runtime
 * authority; this is the documentation side mirroring them.
 */
export function servedPath(entity: MetaObject, apiPrefix: string): string {
  return `${apiPrefix}${restPath(entity)}`;
}

/**
 * True when a FORM is generated for this object.
 *
 * `servesWriteApi` is NOT the same question, and the difference is a TPH hierarchy. The
 * discriminator BASE has a writable SOURCE — which is all `servesWriteApi` asks — but no
 * write ENDPOINT: `routes-file.ts` mounts it with `expose: ["list", "get"]`, because the
 * discriminated union has no single writable shape. So it gets no form, and there would be
 * nowhere to submit one. Each concrete SUBTYPE gets a form, even though it owns no writable
 * source of its own. A read-only projection gets none: it is instantiable for read, never
 * for write.
 *
 * This is the form generator's own filter, hoisted so `agent/ui.md` can say "there is
 * deliberately no form here" for the same set of objects the generator skips. Asking
 * `servesWriteApi` on the page instead announced a form for every discriminator base.
 */
export function hasGeneratedForm(entity: MetaObject): boolean {
  if (isTphSubtype(entity)) return true; // per-subtype form
  // A discriminator base is never form-rendered directly; `entity` is already known not
  // to be a subtype.
  if (declaresTphDiscriminator(entity)) return false;
  return servesWriteApi(entity) && !isProjection(entity);
}
