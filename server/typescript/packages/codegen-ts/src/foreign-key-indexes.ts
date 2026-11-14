// The indexes `meta migrate` creates because a table has foreign keys, for a generator that maps
// the schema (the Drizzle table's index callback).
//
// Read off the SAME expected schema migrate builds, with the project's schema settings, so the
// mapping declares exactly the indexes the database gets, under the names it gets them. Only
// when `migrate.foreignKeyIndexes` is on: a project without it keeps the mapping it had, and
// `meta verify` advises about each unindexed foreign key instead.

import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import {
  buildExpectedSchemaWithProvenance,
  type SchemaBuildSettings,
} from "@metaobjectsdev/migrate-ts/expected";
import type { Dialect } from "./column-mapper.js";

export interface ForeignKeyIndex {
  name: string;
  columns: readonly string[];
}

type ByFqn = ReadonlyMap<string, readonly ForeignKeyIndex[]>;

// One schema build per (root, settings, dialect) — a run renders every entity against one root.
const cache = new WeakMap<MetaRoot, WeakMap<SchemaBuildSettings, Map<Dialect, ByFqn>>>();

function build(root: MetaRoot, settings: SchemaBuildSettings, dialect: "sqlite" | "postgres"): ByFqn {
  const out = new Map<string, ForeignKeyIndex[]>();
  let built: ReturnType<typeof buildExpectedSchemaWithProvenance>;
  try {
    built = buildExpectedSchemaWithProvenance(root, { ...settings, dialect });
  } catch {
    // A model the schema builder refuses is `meta migrate`'s to report, with its own message.
    return out;
  }
  for (const [table, indexes] of built.foreignKeyIndexes ?? []) {
    const fqn = built.provenance.get(table);
    if (fqn !== undefined) out.set(fqn, indexes.map((ix) => ({ name: ix.name, columns: [...ix.columns] })));
  }
  return out;
}

/**
 * The foreign-key indexes of `obj`'s table, in the order migrate adds them; none unless the
 * project sets `migrate.foreignKeyIndexes`. None on MySQL either: MetaObjects writes no DDL
 * there, and InnoDB indexes every foreign key itself.
 */
export function foreignKeyIndexesOf(
  obj: MetaObject,
  root: MetaRoot,
  settings: SchemaBuildSettings | undefined,
  dialect: Dialect,
): readonly ForeignKeyIndex[] {
  if (settings?.foreignKeyIndexes !== true || dialect === "mysql") return [];
  let bySettings = cache.get(root);
  if (bySettings === undefined) cache.set(root, (bySettings = new WeakMap()));
  let byDialect = bySettings.get(settings);
  if (byDialect === undefined) bySettings.set(settings, (byDialect = new Map()));
  let byFqn = byDialect.get(dialect);
  if (byFqn === undefined) byDialect.set(dialect, (byFqn = build(root, settings, dialect)));
  return byFqn.get(obj.resolutionKey()) ?? [];
}
