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
import { hasAnyRdbSource, hasWritableRdbSource } from "./source-detect.js";

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
