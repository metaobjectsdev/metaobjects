// #208 §7 — the declared-@unmanaged name set.
//
// An @unmanaged DB object is managed elsewhere (Flyway / a hand-migration owns its
// DDL). `meta migrate` must neither create, drop, nor drift-check it. It is already
// absent from the EXPECTED side (buildExpectedSchema Pass 1 skips an @unmanaged table;
// buildProjectionViews skips an @unmanaged view), so no create is proposed. This set is
// the ACT-side half: threaded into `diff`, it excludes these names from the introspected
// ACTUAL side so a declared-external object produces SILENCE, not a policy-gated drop.

import {
  MetaSource,
  resolveTableSchema,
  DEFAULT_DB_SCHEMA_POSTGRES,
  type MetaRoot,
} from "@metaobjectsdev/metadata";

/**
 * The qualified physical names (`schema.name`, schema defaulting to Postgres `public`)
 * of every DB object declared `@unmanaged`. The format matches `tableIdentity` /
 * `viewIdentity` in the diff, so one set silences both drop-table and drop-view.
 *
 * Walks each object's OWN sources: `@unmanaged` is per-source (ADR-0007 — physical
 * concerns live on the source child), so a write-through entity can mark only its
 * read-view source `@unmanaged` while its table stays managed. Own-source iteration
 * also keeps `source.physicalName`'s owner-fallback resolving against the declaring
 * object rather than an `extends` super.
 */
export function collectUnmanagedNames(root: MetaRoot): string[] {
  const out: string[] = [];
  for (const obj of root.objects()) {
    for (const src of obj.ownChildren()) {
      if (!(src instanceof MetaSource) || !src.isUnmanaged) continue;
      const schema = resolveTableSchema(obj) ?? DEFAULT_DB_SCHEMA_POSTGRES;
      out.push(`${schema}.${src.physicalName}`);
    }
  }
  return out;
}
