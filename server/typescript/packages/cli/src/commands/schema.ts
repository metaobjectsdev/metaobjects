// `meta schema` (1.3.0 T3) — print the schema the metadata expects, read-only.
//
// The expected schema is the store-neutral contract (ADR-0015 Amendment 2: each language's
// native migration tool is first-class, the Node engine the reference helper). Until this
// command it existed only inside `meta migrate`, which reaches it by diffing against a
// committed snapshot or a live database. This prints it on its own, built by the SAME path
// migrate's offline generate takes — the project's conventions, `migrate.scope` and the
// dependency exclusion, the views codegen-ts lowers projections and reports to — and diffed
// against an EMPTY schema, so the DDL is exactly what `meta migrate` would create for a new
// database. Nothing is read from a database or a snapshot, and nothing is written unless
// `--out` names a file.

import { writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";
import {
  buildExpectedSchemaWithProvenance,
  DIALECTS,
  emit,
  isFkTargetNotUniqueError,
  isUnknownSchemaConventionsError,
  planOffline,
  serializeSnapshot,
  type Dialect,
} from "@metaobjectsdev/migrate-ts";
import { loadMemory, resolveCollection, resolveConfigDir } from "@metaobjectsdev/sdk";
import { parseSchemaArgs } from "../lib/args.js";
import { collectionLoadOptions } from "../lib/collection-load-options.js";
import { resolveMigrateDefaults } from "../lib/config.js";
import { describeError } from "../lib/error-text.js";
import { reportLoadError } from "../lib/load-error.js";
import {
  configNotLoadedWarning,
  loadMemoryOptionsFrom,
  loadMetaobjectsConfig,
  RemovedNamingConfigError,
  resolveGenConfigDir,
} from "../lib/load-metaobjects-config.js";
import { log } from "../lib/log.js";
import { importedOption, migrateScopeMismatch } from "../lib/migrate-scope.js";
import { schemaBuildOptions } from "../lib/schema-build-options.js";

const PREFIX = "schema";

function isDialect(value: string): value is Dialect {
  return (DIALECTS as readonly string[]).includes(value);
}

export async function schemaCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parseSchemaArgs(args);
  } catch (err) {
    log.error(`${PREFIX}: ${describeError(err)}`);
    return 2;
  }

  // The same two roots `meta migrate` resolves (see migrateCommand): `.metaobjects/config.json`
  // governs the metadata and `migrate.*`, the nearest `metaobjects.config.ts` the providers.
  const metaRoot = await resolveConfigDir(cwd);
  const genRoot = resolveGenConfigDir(cwd, metaRoot);

  let genConfig: MetaobjectsGenConfig | undefined;
  let loadOptions: ReturnType<typeof loadMemoryOptionsFrom> = {};
  try {
    genConfig = await loadMetaobjectsConfig(genRoot);
    loadOptions = loadMemoryOptionsFrom(genConfig);
  } catch (err) {
    if (err instanceof RemovedNamingConfigError) {
      log.error(err.message);
      return 2;
    }
    const warning = configNotLoadedWarning(genRoot, err, PREFIX);
    if (warning !== undefined) log.warn(warning);
  }

  const dialectName = flags.dialect ?? (await resolveMigrateDefaults(metaRoot)).dialect ?? genConfig?.dialect;
  if (dialectName === undefined) {
    log.error(
      `${PREFIX}: no dialect — pass --dialect ${DIALECTS.join("|")}, or set migrate.dialect in .metaobjects/config.json or dialect in metaobjects.config.ts`,
    );
    return 2;
  }
  if (!isDialect(dialectName)) {
    log.error(
      `${PREFIX}: unknown dialect '${dialectName}' — expected one of ${DIALECTS.join(", ")} ` +
        `(MetaObjects does not own a MySQL schema; the generated Drizzle tables describe it)`,
    );
    return 2;
  }
  const dialect = dialectName;

  let collection;
  let metadata;
  try {
    collection = await resolveCollection(metaRoot);
    metadata = await loadMemory(collection.configDir, { ...collectionLoadOptions(collection), ...loadOptions });
  } catch (err) {
    reportLoadError(log, `${PREFIX}: failed to load metadata`, err);
    return 1;
  }

  let schema;
  try {
    schema = schemaBuildOptions(collection, genConfig);
  } catch (err) {
    if (!isUnknownSchemaConventionsError(err)) throw err;
    log.error(`${PREFIX}: ${err.message}`);
    return 2;
  }

  const views = buildProjectionViews(metadata, { dialect });
  // A migrate.scope that matches nothing is refused, as `meta migrate` refuses it, rather than
  // printing an empty schema that reads as "this model declares no tables".
  const mismatch = migrateScopeMismatch(
    collection,
    () => buildExpectedSchemaWithProvenance(metadata, { ...schema, dialect, views }).provenance,
  );
  if (mismatch !== undefined) {
    log.error(`${PREFIX}: ${mismatch}`);
    return 2;
  }

  let plan;
  try {
    plan = await planOffline({
      ...schema,
      metadata,
      dialect,
      snapshot: { tables: [], views: [] },
      views,
      ...(collection.inMigrateScope !== undefined ? { inScope: collection.inMigrateScope } : {}),
      ...importedOption(collection),
    });
  } catch (err) {
    // A model the schema builder refuses (a duplicate physical name, a foreign key onto a
    // non-unique target) is refused here exactly as `meta migrate` refuses it.
    log.error(`${PREFIX}: ${describeError(err)}`);
    if (isFkTargetNotUniqueError(err)) {
      log.error(
        `${PREFIX}: declare an identity.secondary on the target with exactly the referenced fields, ` +
          `or set migrate.foreignKeyTargets to "warn" in .metaobjects/config.json`,
      );
    }
    return 1;
  }

  // The governed side: under migrate.scope or a dependency, the objects this project does not
  // govern are left out, as `meta migrate` leaves them out of the DDL it writes.
  const text = flags.as === "json"
    ? serializeSnapshot(plan.expected)
    : ddl(emit(plan.diff.changes, { dialect, expectedSchema: plan.expected, actualSchema: { tables: [], views: [] } }).up);

  if (flags.out !== undefined) {
    const outPath = resolvePath(cwd, flags.out);
    try {
      await writeFile(outPath, text, "utf8");
    } catch (err) {
      log.error(`${PREFIX}: cannot write ${outPath} — ${describeError(err)}`);
      return 1;
    }
    log.info(`meta schema — wrote ${outPath}`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

/** The DDL, ending in exactly one newline (an empty model prints nothing). */
function ddl(up: string): string {
  const trimmed = up.trimEnd();
  return trimmed === "" ? "" : `${trimmed}\n`;
}
