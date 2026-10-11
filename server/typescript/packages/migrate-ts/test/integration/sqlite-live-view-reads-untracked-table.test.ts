/**
 * A view in the database that reads a table its `dependsOn` leaves out, on a REAL SQLite.
 *
 * `dependsOn` lists the tables the EXPECTED view reads. The view in the database may read
 * another one: a table the new body no longer reads, or one an `@sql` body joins (ADR-0043).
 * SQLite refuses to change that table while the view stands:
 *
 *   - `ALTER TABLE … DROP COLUMN` of a column the view reads fails with
 *     `error in view <v> after drop column`;
 *   - the recreate-and-copy rebuild fails at its `ALTER TABLE … RENAME TO`, because the view
 *     names a table that does not exist at that moment (`error in view <v>: no such table`).
 *
 * So the view has to be dropped before the table change and created after it. SQLite is the
 * oracle: each test first shows the refusal on the database as it stands, then applies the
 * emitted migration one statement at a time and reads the view back. D1 is SQLite at the SQL
 * level; its cases run inside one transaction with foreign keys on, as remote D1 does, and
 * cover both the native path and the foreign-key cascade rebuild.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, type ExpectedViewInput } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import type { SchemaSnapshot } from "../../src/types.js";

type SqliteDialect = "sqlite" | "d1";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "live-view-reads-"));
  dbPath = join(tmpDir, "t.db");
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const VIEW = "v_games";
const READS_SCORES = "SELECT g.id AS id, (SELECT count(*) FROM scores s WHERE s.points > 0) AS scored FROM games g";
const READS_GAMES_ONLY = "SELECT g.id AS id, 0 AS scored FROM games g";
/** The view as the model declares it: `games` is the one table it is known to read. */
const view = (sql: string): ExpectedViewInput => ({ name: VIEW, sql, dependsOn: ["games"] });

const entity = (name: string, table: string, children: unknown[]): unknown => ({
  "object.entity": { name, children: [
    { "source.rdb": { "@table": table } },
    { "field.long": { name: "id" } },
    ...children,
    { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
  ] },
});
const GAME = entity("Game", "games", []);
const points = (required: boolean): unknown => ({ "field.int": { name: "points", ...(required ? { "@required": true } : {}) } });
const score = (...fields: unknown[]): unknown => entity("Score", "scores", fields);
/** A table that references `scores`, which makes a rebuild of `scores` a D1 cascade. */
const TALLY = entity("Tally", "tallies", [
  { "field.long": { name: "scoreId", "@required": true } },
  { "identity.reference": { name: "ref_score", "@fields": ["scoreId"], "@references": "Score" } },
]);

async function build(dialect: SqliteDialect, entities: unknown[], views: ExpectedViewInput[]): Promise<SchemaSnapshot> {
  const json = JSON.stringify({ "metadata.root": { package: "acme", children: entities } });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  return buildExpectedSchema(root, { dialect, columnNamingStrategy: "snake_case", views });
}

async function introspect(): Promise<SchemaSnapshot> {
  const k = new Kysely<Record<string, unknown>>({ dialect: new LibsqlDialect({ url: `file:${dbPath}` }) });
  try {
    return await introspectSqlite(k);
  } finally {
    await k.destroy();
  }
}

function withDb<T>(use: (db: Database) => T): T {
  const db = new Database(dbPath);
  try {
    return use(db);
  } finally {
    db.close();
  }
}

/** The statements of an emitted migration, without comment-only lines. */
function statements(up: string): string[] {
  return up.split(";")
    .map((s) => s.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

/** Apply one statement at a time. D1 runs a file in one transaction with foreign keys on. */
function apply(dialect: SqliteDialect, up: string): void {
  withDb((db) => {
    if (dialect === "sqlite") {
      for (const s of statements(up)) db.run(s);
      return;
    }
    db.run("PRAGMA foreign_keys = ON");
    db.run("BEGIN");
    try {
      for (const s of statements(up)) db.run(s);
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  });
}

async function plan(dialect: SqliteDialect, expected: SchemaSnapshot) {
  const actual = await introspect();
  const planned = await diff({ expected, actual, dialect, allow: { dropColumn: true, dropView: true } });
  expect(planned.blocked).toEqual([]);
  const { up } = emit(planned.changes, {
    dialect, expectedSchema: expected, actualSchema: actual,
    ...(actual.meta !== undefined ? { actualMeta: actual.meta } : {}),
  });
  return { changes: planned.changes, up };
}

async function migrate(dialect: SqliteDialect, expected: SchemaSnapshot): Promise<string[]> {
  const { changes, up } = await plan(dialect, expected);
  apply(dialect, up);
  expect((await plan(dialect, expected)).changes).toEqual([]);
  return changes.map((c) => c.kind);
}

/** SQLite refuses `sqlText` on the database as it stands; nothing of the attempt is kept. */
function refuses(sqlText: string[], refusal: RegExp): void {
  withDb((db) => {
    db.run("BEGIN");
    try {
      expect(() => { for (const s of sqlText) db.run(s); }).toThrow(refusal);
    } finally {
      db.run("ROLLBACK");
    }
  });
}
const DROP_POINTS = [`ALTER TABLE "scores" DROP COLUMN "points"`];
const REBUILD_SCORES = [
  `CREATE TABLE "__rebuilt_scores" AS SELECT * FROM "scores"`,
  `DROP TABLE "scores"`,
  `ALTER TABLE "__rebuilt_scores" RENAME TO "scores"`,
];
const AFTER_DROP_COLUMN = /error in view v_games after drop column/;
const NO_SUCH_TABLE = /error in view v_games: no such table: main\.scores/;

const viewRows = (): unknown[] => withDb((db) => db.query(`SELECT id, scored FROM "${VIEW}"`).all());
const viewExists = (): boolean =>
  withDb((db) => db.query(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'view' AND name = '${VIEW}'`).get() as { n: number }).n === 1;
const scoresColumns = (): string[] =>
  withDb((db) => (db.query(`PRAGMA table_info("scores")`).all() as { name: string }[]).map((c) => c.name));
const seedGame = (): void => withDb((db) => { db.run(`INSERT INTO "games" ("id") VALUES (7)`); });

describe.each(["sqlite", "d1"] as const)("a live view that reads a table outside dependsOn (%s)", (dialect) => {
  test("the new body no longer reads the table, and the plan drops a column the live body reads", async () => {
    await migrate(dialect, await build(dialect, [GAME, score(points(false))], [view(READS_SCORES)]));
    seedGame();
    refuses(DROP_POINTS, AFTER_DROP_COLUMN);

    const kinds = await migrate(dialect, await build(dialect, [GAME, score()], [view(READS_GAMES_ONLY)]));
    expect(kinds).toContain("drop-column");
    expect(scoresColumns()).toEqual(["id"]);
    expect(viewRows()).toEqual([{ id: 7, scored: 0 }]);
  });

  test("the new body no longer reads the table, and the plan rebuilds the table", async () => {
    await migrate(dialect, await build(dialect, [GAME, score(points(true))], [view(READS_SCORES)]));
    seedGame();
    refuses(REBUILD_SCORES, NO_SUCH_TABLE);

    const kinds = await migrate(dialect, await build(dialect, [GAME, score(points(false))], [view(READS_GAMES_ONLY)]));
    expect(kinds).toContain("change-column-nullable");
    expect(viewRows()).toEqual([{ id: 7, scored: 0 }]);
  });

  test("an unchanged body that joins the table, and the plan rebuilds the table", async () => {
    await migrate(dialect, await build(dialect, [GAME, score(points(true))], [view(READS_SCORES)]));
    seedGame();
    refuses(REBUILD_SCORES, NO_SUCH_TABLE);

    const kinds = await migrate(dialect, await build(dialect, [GAME, score(points(false))], [view(READS_SCORES)]));
    expect(kinds).toContain("change-column-nullable");
    expect(viewRows()).toEqual([{ id: 7, scored: 0 }]);
  });
});

// A table another table references is rebuilt by the D1 foreign-key cascade, which drops and
// renames every table in the affected set inside the one transaction.
describe("a live view that reads a table the D1 cascade rebuilds", () => {
  const before = () => build("d1", [GAME, score(points(true)), TALLY], [view(READS_SCORES)]);
  const rebuilt = (views: ExpectedViewInput[]) => build("d1", [GAME, score(points(false)), TALLY], views);

  test.each([
    ["the new body no longer reads the table", READS_GAMES_ONLY],
    ["the body is unchanged", READS_SCORES],
  ])("%s: the view is dropped before the cascade and created after it", async (_, body) => {
    await migrate("d1", await before());
    seedGame();
    refuses(REBUILD_SCORES, NO_SUCH_TABLE);

    await migrate("d1", await rebuilt([view(body)]));
    expect(viewRows()).toEqual([{ id: 7, scored: 0 }]);
  });

  test("the model no longer declares the view: it is dropped before the cascade", async () => {
    await migrate("d1", await before());
    refuses(REBUILD_SCORES, NO_SUCH_TABLE);

    const kinds = await migrate("d1", await rebuilt([]));
    expect(kinds).toContain("drop-view");
    expect(viewExists()).toBe(false);
  });
});
