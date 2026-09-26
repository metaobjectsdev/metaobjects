// The "now migrate" next step `meta gen` prints — WHEN a schema change is plausible,
// and in the project's own dialect.
//
// It used to be one hardcoded line on every run that wrote a file:
// `meta migrate --from-db --db <url> --dialect <sqlite|postgres> --slug init --apply`.
// That was wrong twice over for a D1 project (whose migrate takes `--dialect d1 --d1
// <binding>` and applies through wrangler), and it was noise after any change that
// cannot reach the database — a value object or a prompt payload has no table.
//
// The decision, most precise evidence first:
//   1. No table-backed object in the model → no advice (nothing to migrate, ever).
//   2. Nothing written this run → no advice.
//   3. A committed schema snapshot exists → advise exactly when the expected schema's
//      TABLES differ from it (the same diff `meta migrate` runs offline).
//   4. No snapshot (a D1 project, or before the first migrate) → advise when a file
//      generated for a table-backed object, or the shared enums module (enum members
//      are CHECK constraints), changed this run. Files of value objects, prompts and
//      other sourceless declarations do not count.
import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import {
  buildExpectedSchemaWithProvenance,
  diff,
  findWranglerConfig,
  parseWranglerConfig,
  readSnapshot,
  snapshotPath,
  type Change,
  type D1Binding,
} from "@metaobjectsdev/migrate-ts";

/** The FQN separator; an object's short name is the segment after the last one. */
const FQN_SEPARATOR = "::";
/** The shared enums module `entityFile()` emits (its members back CHECK constraints). */
const SHARED_ENUMS_BASENAME = "enums.ts";

const VIEW_CHANGE_KINDS: ReadonlySet<Change["kind"]> = new Set(["create-view", "drop-view", "replace-view"]);

export interface GenMigrateAdviceInput {
  metadata: MetaRoot;
  /** `metaobjects.config.ts` `dialect` — undefined when no DB code is generated. */
  dialect: "sqlite" | "postgres" | undefined;
  /** `.metaobjects/config.json` `migrate.dialect`, when set (may say `d1`). */
  migrateDialect: "sqlite" | "postgres" | "d1" | undefined;
  columnNamingStrategy: "snake_case" | "literal" | "kebab-case" | undefined;
  projectRoot: string;
  /** The migrations directory `meta migrate` uses (holds the committed snapshot). */
  migrateOutDir: string;
  /** Paths (any form) of the files this run wrote, merged or removed. */
  changedFiles: readonly string[];
}

/** The next-step line, or undefined when this run cannot have changed the schema. */
export async function genMigrateAdvice(input: GenMigrateAdviceInput): Promise<string | undefined> {
  if (input.dialect === undefined || input.changedFiles.length === 0) return undefined;

  const d1 = d1BindingFor(input);
  const schemaDialect = d1 !== undefined ? "d1" : input.dialect;
  let built;
  try {
    built = buildExpectedSchemaWithProvenance(input.metadata, {
      dialect: schemaDialect,
      ...(input.columnNamingStrategy !== undefined ? { columnNamingStrategy: input.columnNamingStrategy } : {}),
    });
  } catch {
    // A model `meta migrate` would refuse (it says why); gen is not the place to report it.
    return undefined;
  }
  const expected = { tables: built.snapshot.tables, views: [] };
  if (expected.tables.length === 0) return undefined;

  const snapPath = snapshotPath(resolvePath(input.projectRoot, input.migrateOutDir), schemaDialect);
  const snapshot = existsSync(snapPath) ? await readSnapshot(snapPath) : null;
  if (snapshot !== null) {
    const actual = { ...snapshot, views: [] };
    try {
      const d = await diff({ expected, actual, dialect: schemaDialect });
      if (d.changes.every((c) => VIEW_CHANGE_KINDS.has(c.kind))) return undefined;
    } catch {
      // A diff the engine refuses (a primary-key move, say) is still a schema change.
    }
  } else if (!touchesTableBackedObject(input.changedFiles, built.provenance)) {
    return undefined;
  }

  if (d1 !== undefined) {
    const db = d1.database_name.length > 0 ? d1.database_name : "<database>";
    return `write the schema change as a D1 migration with \`meta migrate --dialect d1 --d1 ${d1.binding} ` +
      `--slug <name>\`, then apply it with \`wrangler d1 migrations apply ${db} --local\``;
  }
  return snapshot === null
    ? `create your database tables with \`meta migrate --from-db --db <url> --dialect ${input.dialect} --slug init --apply\``
    : `migrate the schema change with \`meta migrate --db <url> --dialect ${input.dialect} --slug <name> --apply\``;
}

/** The project's D1 binding when it migrates through D1, else undefined. */
function d1BindingFor(input: GenMigrateAdviceInput): D1Binding | undefined {
  if (input.dialect !== "sqlite" && input.migrateDialect !== "d1") return undefined;
  const path = findWranglerConfig(input.projectRoot);
  if (path === undefined) return undefined;
  try {
    return parseWranglerConfig(path).d1Bindings[0];
  } catch {
    return undefined;
  }
}

/**
 * Whether a changed file was generated for a table-backed object: its basename starts
 * with that object's short name followed by a `.` (`Pet.ts`, `Pet.queries.ts`), or it
 * is the shared enums module.
 */
function touchesTableBackedObject(
  changedFiles: readonly string[],
  provenance: ReadonlyMap<string, string>,
): boolean {
  const shortName = (fqn: string): string => {
    const at = fqn.lastIndexOf(FQN_SEPARATOR);
    return at === -1 ? fqn : fqn.slice(at + FQN_SEPARATOR.length);
  };
  const names = new Set([...provenance.values()].map(shortName));
  return changedFiles.some((f) => {
    const base = basename(f);
    if (base === SHARED_ENUMS_BASENAME) return true;
    const dot = base.indexOf(".");
    return dot > 0 && names.has(base.slice(0, dot));
  });
}
