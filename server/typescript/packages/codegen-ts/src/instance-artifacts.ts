// Framework-level guard shared by every generator that emits INSTANCE / WRITE
// artifacts (write forms, CRUD hooks, grid columns, grid hooks, …).
//
// THREE things make an object *not* a source of instance artifacts:
//
//   1. Abstract (`@isAbstract: true`) — a fundamental MetaData concept: an
//      abstract type contributes shape via inheritance ONLY. It never has an
//      instantiable representation, so it must never produce a write form,
//      CRUD hooks, columns, a grid, or any instance artifact. It still gets a
//      type-only interface from the entity-file generator (so subclasses and
//      consumers can reference its shape), but nothing that points at an
//      `<E>Insert` schema / `$table` / mutation hook it does not have.
//
//   2. SOURCELESS — no declared/inherited `source.*` at all. #248 settled that DB
//      participation derives from a declared source, never from the object subtype,
//      and the routes/queries tier already gates on exactly this. An instance
//      artifact is a client for a route: hooks fetch one, a grid renders what hooks
//      return, a form submits to one. A sourceless object has no route, so there is
//      nothing for any of them to talk to. This subsumes `object.value` — a value is
//      sourceless by loader-enforced purity (ADR-0028) — WITHOUT reintroducing a
//      subtype check, which is the family #248 spent two releases eradicating. It
//      also covers sourceless entities and the sourceless `object.projection` that
//      #210 made the recommended payload re-host: that shape's generated surface is
//      the payload VO + render helper + output parser, never TanStack CRUD.
//
//      This is a BUG FIX, not a policy change. Before it, a value object got a
//      `<V>.hooks.ts` importing `<V>Filter` / `<V>Insert` / `<V>Update` and the
//      `<V>` const — none of which the entity module emits for a value — so the
//      generated file could not typecheck (TS2305 ×3, TS2693) and could not even
//      link under native ESM. There was never working output here to lose.
//
//   3. Projection (read-only view; see `isProjection`) — instantiable for READ
//      but never for WRITE. It legitimately gets read models + read-only hooks
//      + grids, but NOT a write form. WRITE-only generators (forms) reuse
//      `emitsWriteArtifacts` to skip these; read-capable generators (tanstack
//      hooks/grids) instead branch internally on `isProjection`.
//
// Centralizing these as `emitsInstanceArtifacts` / `emitsWriteArtifacts` keeps
// the rule in one place: a generator composes the matching guard into its
// `filter` rather than re-deriving "is this abstract / read-only / persisted" ad
// hoc — and a third-party generator composing the guard inherits the fix.

import type { MetaData, MetaObject } from "@metaobjectsdev/metadata";
import { isProjection } from "./projection/projection-detector.js";
import { hasAnyRdbSource, hasWritableRdbSource } from "./source-detect.js";

/**
 * True when `entity` is abstract (`@isAbstract: true`).
 *
 * Thin, framework-level accessor so generators in sibling codegen packages
 * have a single import surface for the abstract concept and don't reach into
 * metadata internals (mirrors how `isProjection` is the shared read-only
 * discriminator). Abstract types contribute shape via inheritance only.
 */
export function isAbstract(entity: MetaData): boolean {
  return entity.isAbstract === true;
}

/**
 * True when `entity` should produce INSTANCE artifacts of ANY kind (read OR
 * write): CRUD/read hooks, grid columns, grid hooks. Excludes abstract types
 * (no instantiable representation) and sourceless objects (no route for the
 * artifact to talk to — see the header note, and #248 for the doctrine).
 *
 * Read-capable generators (tanstack hooks/grids) compose this so they skip
 * abstract bases while still serving VIEW-BACKED projections via their own
 * `isProjection` read-only branch — a projection over a `@kind: view` source
 * has a source, so it passes here and keeps its read-only hooks.
 */
export function emitsInstanceArtifacts(entity: MetaObject): boolean {
  return !isAbstract(entity) && hasAnyRdbSource(entity);
}

/**
 * True when `entity` should produce WRITE artifacts (write forms, mutation
 * surfaces). Excludes abstract types (no instance at all), projections
 * (read-only views — instantiable for read, never for write), and objects with
 * no WRITABLE source (nothing to submit to; this is the same predicate the
 * entity-file generator uses to decide whether an `Insert`/`Update` surface
 * exists at all, so a form can no longer be emitted against schemas that were
 * never generated).
 *
 * WRITE-only generators (e.g. the React form generator) compose this.
 */
export function emitsWriteArtifacts(entity: MetaObject): boolean {
  return !isAbstract(entity) && !isProjection(entity) && hasWritableRdbSource(entity);
}
