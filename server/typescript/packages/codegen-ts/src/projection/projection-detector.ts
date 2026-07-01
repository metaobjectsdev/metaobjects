import { MetaSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";

function hasReadOnlyKindSource(entity: MetaData): boolean {
  // ADR-0039: own — projection source-kind classification. Mirrors C#
  // IsReadOnlyProjection()/projection OwnSources: an entity's projection-ness is
  // determined by its OWN declared source @kind, not one inherited via extends.
  return entity.ownChildren().some(
    (c) => c instanceof MetaSource && c.isReadOnly(),
  );
}

function hasWritableKindSource(entity: MetaData): boolean {
  // ADR-0039: own — projection source-kind classification (see hasReadOnlyKindSource).
  return entity.ownChildren().some(
    (c) => c instanceof MetaSource && c.isWritable(),
  );
}

export function isProjection(entity: MetaData): boolean {
  return hasReadOnlyKindSource(entity) && !hasWritableKindSource(entity);
}

export function isWriteThrough(entity: MetaData): boolean {
  return hasReadOnlyKindSource(entity) && hasWritableKindSource(entity);
}
