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

import type { MetaObject } from "@metaobjectsdev/metadata";
import { isAbstract } from "./instance-artifacts.js";
import { isProjection } from "./projection/projection-detector.js";
import { hasAnyRdbSource, hasWritableRdbSource } from "./source-detect.js";
import { resourcePath } from "./templates/entity-ui-descriptor.js";
import {
  declaresTphDiscriminator,
  isTphSubtype,
  tphDiscriminatorBase,
  tphDiscriminatorPin,
} from "./templates/zod-validators.js";
import { tphRouteSegment } from "./templates/tph-discriminator.js";

/**
 * True when the object is served by a generated READ endpoint — so a hook has
 * something to fetch and a grid has something to render.
 *
 * Abstract types are excluded (no instance to address). Today the endpoint test is
 * "declares or inherits a `source.rdb`", which is precisely the predicate
 * `routesFile` / `routesFileHono` gate on, so hooks exist exactly where routes do.
 */
export function servesReadApi(entity: MetaObject): boolean {
  return !isAbstract(entity) && hasAnyRdbSource(entity);
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

/**
 * THE address the generated routes serve this object at.
 *
 * `resourcePath` answers "what is this object's own `$path`", which is what the
 * `<Entity>` const emits. That is NOT the same question for a TPH SUBTYPE: it emits no
 * routes file of its own — `routes-file.ts` mounts the whole hierarchy from the
 * discriminator BASE, giving the union read-only routes at the base path and each
 * subtype a full CRUD set at `<base path>/<route segment>` — so a subtype's own `$path`
 * names an endpoint that does not exist. `agent/ui.md` printed exactly that, as fact.
 *
 * The composition here is the same one `routes-file.ts` and the TanStack
 * `hooks-file.ts` emit as CODE (`Base.$path + "/car"`); they must reference the const
 * rather than a computed string, so this is the one place the composition can be
 * evaluated. The SEGMENT rule is not restated — `tphRouteSegment` owns it, and all three
 * read it from there.
 */
export function restPath(entity: MetaObject): string {
  const pin = tphDiscriminatorPin(entity);
  const base = tphDiscriminatorBase(entity);
  if (pin === undefined || base === undefined) return resourcePath(entity);
  return `${resourcePath(base)}/${tphRouteSegment(pin.value)}`;
}

/**
 * True when a FORM is generated for this object.
 *
 * `servesWriteApi` is NOT the same question, and the difference is a TPH hierarchy. The
 * discriminator BASE has a writable source and a write endpoint, yet gets no form — you
 * cannot create a base, and its polymorphic mount is read-only by construction (the
 * discriminated union has no single writable shape). Each concrete SUBTYPE gets one, even
 * though it owns no writable source of its own. A read-only projection gets none: it is
 * instantiable for read, never for write.
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
