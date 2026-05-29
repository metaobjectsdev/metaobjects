// Framework-level guard shared by every generator that emits INSTANCE / WRITE
// artifacts (write forms, CRUD hooks, grid columns, grid hooks, …).
//
// Two MetaData concepts make an entity *not* a source of instance artifacts:
//
//   1. Abstract (`@isAbstract: true`) — a fundamental MetaData concept: an
//      abstract type contributes shape via inheritance ONLY. It never has an
//      instantiable representation, so it must never produce a write form,
//      CRUD hooks, columns, a grid, or any instance artifact. It still gets a
//      type-only interface from the entity-file generator (so subclasses and
//      consumers can reference its shape), but nothing that points at an
//      `<E>Insert` schema / `$table` / mutation hook it does not have.
//
//   2. Projection (read-only view; see `isProjection`) — instantiable for READ
//      but never for WRITE. It legitimately gets read models + read-only hooks
//      + grids, but NOT a write form. WRITE-only generators (forms) reuse
//      `emitsWriteArtifacts` to skip these; read-capable generators (tanstack
//      hooks/grids) instead branch internally on `isProjection`.
//
// Centralizing these as `emitsInstanceArtifacts` / `emitsWriteArtifacts` keeps
// the rule in one place: a generator composes the matching guard into its
// `filter` rather than re-deriving "is this abstract / read-only" ad hoc.

import type { MetaData } from "@metaobjectsdev/metadata";
import { isProjection } from "./projection/projection-detector.js";

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
 * write): CRUD/read hooks, grid columns, grid hooks. Abstract types are
 * excluded — they have no instantiable representation.
 *
 * Read-capable generators (tanstack hooks/grids) compose this so they skip
 * abstract bases while still serving projections via their own
 * `isProjection` read-only branch.
 */
export function emitsInstanceArtifacts(entity: MetaData): boolean {
  return !isAbstract(entity);
}

/**
 * True when `entity` should produce WRITE artifacts (write forms, mutation
 * surfaces). Excludes both abstract types (no instance at all) and projections
 * (read-only views — instantiable for read, never for write).
 *
 * WRITE-only generators (e.g. the React form generator) compose this.
 */
export function emitsWriteArtifacts(entity: MetaData): boolean {
  return !isAbstract(entity) && !isProjection(entity);
}
