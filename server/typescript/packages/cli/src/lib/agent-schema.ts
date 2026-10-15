// The physical schema `agent/schema.md` describes (the `agent-docs` generator), built by the
// package that owns it, `migrate-ts`, with its own resolvers handed across. codegen-ts
// deliberately computes none of it (see agent-schema-input.ts there), so `meta gen` and
// `meta verify --codegen` build it here and hand it to the run as `RunGenOpts.agentSchema`;
// the runner calls it only when a declared generator asks.

import {
  buildProjectionViews,
  dbEmittingObjects,
  DEFAULT_DIALECT,
  missingDialectMessage,
} from "@metaobjectsdev/codegen-ts";
import type { AgentSchemaInput, Dialect, SchemaColumnLike } from "@metaobjectsdev/codegen-ts";
import { buildExpectedSchemaWithProvenance, columnTypeSql, qualifiedDbName } from "@metaobjectsdev/migrate-ts";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { describeError } from "./error-text.js";

/**
 * The schema for `agent/schema.md`, or undefined, after saying why through `warn`, when the
 * page is to be SKIPPED. A skipped page is not a silent pass: `meta verify --codegen` convicts
 * a committed `agent/schema.md` that a fresh run no longer writes.
 */
export function buildAgentSchemaInput(
  root: MetaRoot,
  configured: Dialect | undefined,
  warn: (message: string) => void,
): AgentSchemaInput | undefined {
  // THE RUNNER'S OWN GUARD DECIDES THIS, not a default applied here. `DEFAULT_DIALECT` is
  // inert: `meta gen` refuses a model that emits database code with no dialect declared, so a
  // persisted model with no dialect is not a sqlite project. Documenting it as one would state
  // an answer the toolchain never gave. A model with no persisted object needs no dialect and
  // renders an empty schema page anyway, so the inert default is right for exactly the
  // projects the guard lets through.
  const dbEmitting = dbEmittingObjects(root.objects());
  if (dbEmitting.length > 0 && configured === undefined) {
    warn(`agent/schema.md skipped — ${missingDialectMessage(dbEmitting)}`);
    return undefined;
  }
  // MySQL: MetaObjects does not own the schema, so there is no migrate-built schema to
  // describe. The generated Drizzle tables are the description.
  if (configured === "mysql") {
    warn("agent/schema.md skipped — MetaObjects does not own a MySQL schema (the generated Drizzle tables describe it).");
    return undefined;
  }
  const dialect = configured ?? DEFAULT_DIALECT;
  try {
    const built = buildExpectedSchemaWithProvenance(root, {
      dialect,
      // Views come from codegen-ts (migrate-ts never generates view DDL), exactly as
      // `verify --db` threads them.
      views: buildProjectionViews(root, { dialect }),
    });
    return {
      dialect,
      tables: built.snapshot.tables,
      views: built.snapshot.views,
      provenance: built.provenance,
      // The structural `SchemaColumnLike` is migrate-ts's own ColumnDescriptor, narrowed to
      // what the page reads; the cast hands the full descriptor back to the renderer that
      // produced it.
      columnType: (c: SchemaColumnLike) => columnTypeSql(c as never, dialect),
      qualify: qualifiedDbName,
    };
  } catch (err) {
    // A model the schema builder refuses is a real condition (a primary-key move, a duplicate
    // physical name) that `meta migrate` reports properly. Documentation must not be the
    // command that fails on it, so the schema page is skipped and the other pages still emit.
    warn(
      `agent/schema.md skipped — the expected schema could not be built ` +
        `(${describeError(err)}). Run 'meta migrate' for the full diagnosis.`,
    );
    return undefined;
  }
}
