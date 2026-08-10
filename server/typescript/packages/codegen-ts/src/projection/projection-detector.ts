// isReadOnlySource / isWritableSource rather than `instanceof MetaSource`: a
// second physical copy of @metaobjectsdev/metadata makes the class check false
// for a real source, which would silently reclassify every projection and
// write-through entity as a vanilla entity.
import { isReadOnlySource, isWritableSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";

function hasReadOnlyKindSource(entity: MetaData): boolean {
  // ADR-0039: own — projection source-kind classification. Mirrors C#
  // IsReadOnlyProjection()/projection OwnSources: an entity's projection-ness is
  // determined by its OWN declared source @kind, not one inherited via extends.
  return entity.ownChildren().some(isReadOnlySource);
}

function hasWritableKindSource(entity: MetaData): boolean {
  // ADR-0039: own — projection source-kind classification (see hasReadOnlyKindSource).
  return entity.ownChildren().some(isWritableSource);
}

export function isProjection(entity: MetaData): boolean {
  return hasReadOnlyKindSource(entity) && !hasWritableKindSource(entity);
}

export function isWriteThrough(entity: MetaData): boolean {
  return hasReadOnlyKindSource(entity) && hasWritableKindSource(entity);
}
