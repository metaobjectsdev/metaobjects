// server/typescript/packages/cli/src/lib/schema-build-options.ts
//
// The project settings every expected-schema build takes, resolved in ONE place.
//
// The schema conventions (`migrate.conventions` in `.metaobjects/config.json`, or a
// conventions object from `metaobjects.config.ts`) and `migrate.checks.skipRedundant` are
// migrate settings, not facts about the model, so the loaded model does not carry them:
// each command resolves them here and passes the result to every build and drift
// computation. The helpers that build an expected schema take it as a REQUIRED
// parameter, so a call site that forgets it is a compile error rather than a silent
// default — the way #333 happened to `libraries` (see `loadMemoryOptionsFrom`).
import type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";
import { isUnknownSchemaConventionsError, resolveSchemaConventions, type SchemaConventions } from "@metaobjectsdev/migrate-ts";
import type { Collection } from "@metaobjectsdev/sdk";

/** What an expected-schema build needs from the project, every member resolved. */
export interface SchemaBuildOptions {
  conventions: SchemaConventions;
  skipRedundantChecks: boolean;
  /** `migrate.foreignKeyIndexes`: index every foreign key nothing else indexes. */
  foreignKeyIndexes: boolean;
}

/**
 * The project's schema settings. A conventions object from `metaobjects.config.ts` wins over
 * the `migrate.conventions` preset name. Throws `UnknownSchemaConventionsError` for a preset
 * this version does not ship and `InvalidSchemaConventionsError` for an object missing a
 * member (`isUnknownSchemaConventionsError` recognises both).
 */
export function schemaBuildOptions(
  collection: Pick<Collection, "schemaConventions" | "skipRedundantChecks" | "foreignKeyIndexes">,
  tsConfig: Pick<MetaobjectsGenConfig, "schemaConventions"> | undefined,
): SchemaBuildOptions {
  return {
    conventions: resolveSchemaConventions(tsConfig?.schemaConventions ?? collection.schemaConventions),
    skipRedundantChecks: collection.skipRedundantChecks,
    foreignKeyIndexes: collection.foreignKeyIndexes,
  };
}

/**
 * {@link schemaBuildOptions} for a command that only ADVISES from the schema (`meta gen`'s
 * schema page and next-step line): conventions that do not resolve are warned about and the
 * result is undefined, so the caller skips what needed them. `meta migrate` and `meta verify`
 * refuse the same config with exit 2.
 */
export function schemaBuildOptionsOrWarn(
  collection: Pick<Collection, "schemaConventions" | "skipRedundantChecks" | "foreignKeyIndexes">,
  tsConfig: Pick<MetaobjectsGenConfig, "schemaConventions"> | undefined,
  warn: (message: string) => void,
): SchemaBuildOptions | undefined {
  try {
    return schemaBuildOptions(collection, tsConfig);
  } catch (err) {
    if (!isUnknownSchemaConventionsError(err)) throw err;
    warn(`${err.message}; the schema-derived output (agent/schema.md, the migrate advice) is skipped`);
    return undefined;
  }
}
