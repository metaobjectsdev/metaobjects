/**
 * The loaded model and everything built from it: the ObjectManager, the database schema,
 * and the table of which collection path serves which entity.
 *
 * `reload()` loads the metadata again and swaps all three. Routes ask for `current()` on
 * every request, so a metadata edit takes effect on the next request with no code
 * generated and no route re-registered.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import {
  collectionSegment,
  isWritableSource,
  OBJECT_SUBTYPE_ENTITY,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { emit, planOffline, splitSqlStatements, type SchemaSnapshot } from "@metaobjectsdev/migrate-ts";
import { ObjectManager, type Row } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { loadMemory } from "@metaobjectsdev/sdk";
import { Kysely, sql } from "kysely";
import { assertFilterableSubTypes } from "./list-query";

const SQLITE = "sqlite";
const EMPTY_SCHEMA: SchemaSnapshot = { tables: [], views: [] };

/** One loaded generation of the model. Immutable; a reload makes a new one. */
export interface Model {
  /** 1 for the first load, and one more for each reload since. */
  readonly revision: number;
  readonly root: MetaRoot;
  readonly om: ObjectManager;
  /** Collection path segment (`work_orders`) to the entity it serves. */
  readonly served: ReadonlyMap<string, MetaObject>;
}

export interface Runtime {
  current(): Model;
  /** Load the metadata again, bring the schema up to it, and swap the model in. */
  reload(): Promise<Model>;
  /**
   * The connection underneath the ObjectManager. Nothing that serves a request uses it:
   * it is here for `scripts/measure.ts`, which times the ObjectManager against the same
   * query written by hand.
   */
  readonly db: Kysely<Record<string, Row>>;
  close(): Promise<void>;
}

/**
 * The entities this server answers for: concrete `object.entity` nodes with a writable
 * source. A value object, an abstract base and a read-only projection have no table to
 * write, so they get no collection.
 */
function servedEntities(root: MetaRoot): ReadonlyMap<string, MetaObject> {
  const served = new Map<string, MetaObject>();
  for (const object of root.objects()) {
    if (object.subType !== OBJECT_SUBTYPE_ENTITY || object.isAbstract) continue;
    if (!object.children().some((child) => isWritableSource(child))) continue;
    assertFilterableSubTypes(object);
    served.set(collectionSegment(object), object);
  }
  return served;
}

/**
 * Bring the database from `from` to what `root` declares, and return the schema it now has.
 * The DDL is the migration engine's own output for this model: `meta migrate` would write
 * the same statements to a file.
 */
async function syncSchema(db: Kysely<Record<string, Row>>, root: MetaRoot, from: SchemaSnapshot): Promise<SchemaSnapshot> {
  // Replacing a CHECK constraint is allowed, because that is what adding a member to an
  // enum is, and it loses no data. Nothing else destructive is: a change that drops a
  // column or a table throws here, and the caller keeps serving the model it already has.
  const plan = await planOffline({ metadata: root, dialect: SQLITE, snapshot: from, allow: { dropCheck: true } });
  const emitted = emit(plan.diff.changes, { dialect: SQLITE, expectedSchema: plan.expected, actualSchema: from });
  for (const statement of splitSqlStatements(emitted.up, { dialect: SQLITE })) {
    await sql.raw(statement).execute(db);
  }
  return plan.nextSnapshot;
}

export interface OpenRuntimeOptions {
  /** The project directory: the one holding `.metaobjects/config.json`. */
  readonly projectDir: string;
  /**
   * Shown every statement the database is sent, as its text and its bound values apart.
   * The tests use it to prove request text only ever travels as a bound value.
   */
  readonly onStatement?: (sql: string, parameters: readonly unknown[]) => void;
}

/** Open a throwaway SQLite database, load the project's metadata and build the model. */
export async function openRuntime(options: OpenRuntimeOptions): Promise<Runtime> {
  // A scratch database: created for this process and removed by `close()`.
  const scratch = mkdtempSync(join(process.env["DEV_SCRATCH"] ?? tmpdir(), "dynamic-grid-"));
  const onStatement = options.onStatement;
  const db = new Kysely<Record<string, Row>>({
    dialect: new LibsqlDialect({ url: `file:${join(scratch, "demo.db")}` }),
    ...(onStatement !== undefined ? { log: (event) => onStatement(event.query.sql, event.query.parameters) } : {}),
  });
  const driver = kyselyDriver({ db, dialect: SQLITE });

  let schema = EMPTY_SCHEMA;
  let model: Model | undefined;

  async function reload(): Promise<Model> {
    const root = await loadMemory(options.projectDir);
    const served = servedEntities(root);
    schema = await syncSchema(db, root, schema);
    model = { revision: (model?.revision ?? 0) + 1, root, om: new ObjectManager({ metadata: root, driver }), served };
    return model;
  }

  await reload();

  return {
    current(): Model {
      if (model === undefined) throw new Error("the model has not loaded");
      return model;
    },
    reload,
    db,
    async close(): Promise<void> {
      await db.destroy();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
