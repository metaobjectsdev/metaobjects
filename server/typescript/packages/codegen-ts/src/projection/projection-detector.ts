import { MetaSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";

function hasReadOnlyKindSource(entity: MetaData): boolean {
  return entity.ownChildren().some(
    (c) => c instanceof MetaSource && c.isReadOnly(),
  );
}

function hasWritableKindSource(entity: MetaData): boolean {
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
