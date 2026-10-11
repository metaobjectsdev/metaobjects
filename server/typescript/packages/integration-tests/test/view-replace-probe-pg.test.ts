/**
 * Replacing a view in place, against a REAL Postgres (adopter report D2).
 *
 * Postgres replaces a view (`CREATE OR REPLACE VIEW`) only when every existing column keeps
 * its name, type and position and new columns come last. It refuses anything else when the
 * migration is APPLIED (`cannot change data type of view column`). So the planner asks the
 * database before it plans: `postgresViewReplaceProbe` creates the expected definition as a
 * temporary view in a transaction it rolls back, reads the columns Postgres gave it, and
 * compares them with the live view's. A replace is planned only on that evidence; with no
 * evidence the plan is DROP + CREATE.
 *
 * Postgres is the oracle throughout. For a view the plan drops, the test first asks Postgres
 * directly and it refuses the replace. For a view the plan replaces, the replace is applied
 * and the view keeps its OID. The cases cover every kind of derived column (each `origin.*`
 * on a projection, each column kind of a report) and the type pairs a coarser type model
 * cannot tell apart: json and jsonb, smallint and integer, text and character varying.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buildExpectedSchema, diff, emit, introspectPostgres, postgresViewReplaceProbe,
  type AllowOptions, type SchemaSnapshot, type ViewDescriptor, type ViewReplaceProbe,
} from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

type Db = Kysely<Record<string, unknown>>;

let pg: RunningPg;
let k: Db;

const connect = (connectionString: string): Db =>
  new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }) });

beforeAll(async () => {
  pg = await startPostgres();
  k = connect(pg.connectionUri);
}, 120_000);

afterAll(async () => {
  await k.destroy();
  await pg.stop();
}, 60_000);

beforeEach(async () => {
  await sql.raw("DROP SCHEMA public CASCADE").execute(k);
  await sql.raw("CREATE SCHEMA public").execute(k);
});

const STRATEGY = "literal" as const;
const PROBE_RELATION = "mo_view_replace_probe";

const program = (extra: unknown[] = []) => ({
  "object.entity": { name: "Program", children: [
    { "source.rdb": { "@table": "programs" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "status", "@required": true, "@maxLength": 20 } },
    { "field.string": { name: "nickname", "@maxLength": 40 } },
    { "field.string": { name: "notes" } },
    ...extra,
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "relationship.aggregation": { name: "weeks", "@cardinality": "many", "@objectRef": "Week" } },
  ] },
});
const WEEK = {
  "object.entity": { name: "Week", children: [
    { "source.rdb": { "@table": "weeks" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "programId", "@required": true } },
    { "field.string": { name: "label", "@required": true, "@maxLength": 40 } },
    { "field.int": { name: "durationMinutes", "@required": true } },
    { "field.decimal": { name: "score", "@precision": 9, "@scale": 2 } },
    { "field.timestamp": { name: "createdAt", "@required": true } },
    { "field.date": { name: "heldOn" } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
    { "dimension.attribute": { name: "program", "@of": "Week.programId" } },
    { "dimension.attribute": { name: "label", "@of": "Week.label" } },
    { "dimension.time": { name: "createdAt", "@of": "Week.createdAt", "@grains": ["hour", "month"] } },
    { "dimension.time": { name: "heldOn", "@of": "Week.heldOn", "@grains": ["day", "month"] } },
    { "measure.aggregate": { name: "weeks", "@agg": "count", "@of": "Week.id" } },
    { "measure.aggregate": { name: "minutes", "@agg": "sum", "@of": "Week.durationMinutes", "@default": 0 } },
    { "measure.aggregate": { name: "points", "@agg": "sum", "@of": "Week.score" } },
    { "measure.aggregate": { name: "longest", "@agg": "max", "@of": "Week.durationMinutes" } },
    { "measure.aggregate": { name: "bestScore", "@agg": "max", "@of": "Week.score" } },
    { "measure.aggregate": { name: "typical", "@agg": "avg", "@of": "Week.durationMinutes" } },
    { "measure.ratio": { name: "minutesPerWeek", "@numerator": "minutes", "@denominator": "weeks", "@default": 0 } },
  ] },
};
const WEEK_BRIEF = {
  "object.value": { name: "WeekBrief", children: [
    { "field.long": { name: "id" } },
    { "field.string": { name: "label" } },
  ] },
};

const VIA = { "@via": "Program.weeks" };
const SUMMARY_VIEW = "v_program_summary";

/** A projection over Program with its key and the given derived fields. */
function summary(...fields: unknown[]): unknown {
  return {
    "object.projection": { name: "ProgramSummary", children: [
      { "source.rdb": { "@kind": "view", "@table": SUMMARY_VIEW } },
      { "identity.primary": { name: "id", extends: "Program.id", "@fields": "id" } },
      { "field.long": { name: "id", extends: "Program.id", children: [{ "origin.passthrough": { "@from": "Program.id" } }] } },
      ...fields,
    ] },
  };
}

const REPORT = {
  "object.report": {
    name: "WeekStats",
    "@from": "Week",
    "@dimensions": ["program", "label", "createdAt:hour", "createdAt:month", "heldOn:day", "heldOn:month"],
    "@measures": ["weeks", "minutes", "points", "longest", "bestScore", "typical", "minutesPerWeek"],
    children: [{ "source.rdb": { "@kind": "view", "@table": "v_week_stats" } }],
  },
};

const computed = (name: string, subType: string, expr: unknown): Record<string, unknown> =>
  ({ [`field.${subType}`]: { name, children: [{ "origin.computed": { "@expr": expr } }] } });
const COALESCE_NICKNAME = computed("displayName", "string", { fn: "coalesce", args: [{ field: "nickname" }, { value: "unnamed" }] });
const COALESCE_NOTES = computed("displayName", "string", { fn: "coalesce", args: [{ field: "notes" }, { value: "unnamed" }] });

interface Case {
  /** The kind of derived column under test. */
  readonly kind: string;
  /** The object that declares the view. */
  readonly host: unknown;
  readonly view: string;
  /** The column the incompatible hand-written view types differently. */
  readonly column: string;
  /** That column in the hand-written view, given a reference to the derived value. */
  readonly retyped: (ref: string) => string;
}

const cast = (type: string) => (ref: string): string => `CAST(${ref} AS ${type})`;
const projection = (kind: string, field: Record<string, unknown>, retyped: Case["retyped"]): Case => {
  const [declared] = Object.values(field) as { name: string }[];
  return { kind, host: summary(field), view: SUMMARY_VIEW, column: declared!.name, retyped };
};

const CASES: readonly Case[] = [
  projection("passthrough",
    { "field.string": { name: "status", children: [{ "origin.passthrough": { "@from": "Program.status" } }] } },
    cast("text")),
  // The adopter's case: a hand-written view that cast its count to int.
  projection("aggregate count",
    { "field.long": { name: "weekCount", children: [{ "origin.aggregate": { "@agg": "count", "@of": "Week.id", ...VIA } }] } },
    cast("integer")),
  projection("aggregate sum of an integer",
    { "field.long": { name: "totalMinutes", children: [
      { "origin.aggregate": { "@agg": "sum", "@of": "Week.durationMinutes", ...VIA } }] } },
    cast("integer")),
  // An aggregate never reports its argument's length or precision.
  projection("aggregate sum of a decimal",
    { "field.decimal": { name: "totalScore", children: [{ "origin.aggregate": { "@agg": "sum", "@of": "Week.score", ...VIA } }] } },
    cast("numeric(9,2)")),
  projection("aggregate min of a bounded string",
    { "field.string": { name: "firstLabel", children: [{ "origin.aggregate": { "@agg": "min", "@of": "Week.label", ...VIA } }] } },
    cast("varchar(40)")),
  projection("aggregate max of a decimal",
    { "field.decimal": { name: "bestScore", children: [{ "origin.aggregate": { "@agg": "max", "@of": "Week.score", ...VIA } }] } },
    cast("numeric(9,2)")),
  // smallint against integer.
  projection("aggregate min of an integer",
    { "field.int": { name: "shortest", children: [
      { "origin.aggregate": { "@agg": "min", "@of": "Week.durationMinutes", ...VIA } }] } },
    cast("smallint")),
  projection("aggregate avg",
    { "field.decimal": { name: "typicalMinutes", children: [
      { "origin.aggregate": { "@agg": "avg", "@of": "Week.durationMinutes", ...VIA } }] } },
    cast("double precision")),
  projection("aggregate any",
    { "field.boolean": { name: "anyLongWeek", children: [
      { "origin.aggregate": { "@agg": "any", ...VIA, "@filter": { durationMinutes: { gt: 60 } } } }] } },
    cast("integer")),
  projection("aggregate all",
    { "field.boolean": { name: "allLongWeeks", children: [
      { "origin.aggregate": { "@agg": "all", ...VIA, "@filter": { durationMinutes: { gt: 60 } } } }] } },
    cast("integer")),
  // character varying[] (the collect of a bounded string) against text[].
  projection("aggregate collect",
    { "field.string": { name: "weekLabels", isArray: true, children: [
      { "origin.aggregate": { "@agg": "collect", "@of": "Week.label", ...VIA } }] } },
    cast("text[]")),
  // jsonb against json.
  projection("aggregate collect of a whole object",
    { "field.object": { name: "weekBriefs", isArray: true, "@objectRef": "WeekBrief", children: [
      { "origin.aggregate": { "@agg": "collect", ...VIA } }] } },
    cast("json")),
  // A scalar subquery keeps its column's length, where an aggregate over it does not.
  projection("first",
    { "field.string": { name: "latestWeekLabel", children: [
      { "origin.first": { "@of": "Week.label", ...VIA, "@orderBy": ["createdAt:desc"] } }] } },
    cast("text")),
  projection("computed comparison",
    computed("isPublished", "boolean", { op: "eq", left: { field: "status" }, right: { value: "PUBLISHED" } }),
    cast("integer")),
  projection("computed null test",
    computed("isNamed", "boolean", { op: "isNotNull", arg: { field: "nickname" } }),
    cast("integer")),
  projection("computed column reference", computed("alias", "string", { field: "nickname" }), cast("text")),
  // COALESCE(varchar(40), 'x') is a bare character varying, which is not text.
  projection("computed coalesce with a literal", COALESCE_NICKNAME, cast("text")),
  ...([
    ["report count", "weeks", "integer"],
    ["report sum with a default", "minutes", "integer"],
    ["report sum of a decimal", "points", "numeric(9,2)"],
    ["report max of a decimal", "bestScore", "numeric(9,2)"],
    ["report avg", "typical", "double precision"],
    ["report ratio", "minutesPerWeek", "double precision"],
    ["report dimension", "label", "text"],
    ["report hour grain", "createdAtHour", "timestamp"],
    ["report month grain", "createdAtMonth", "timestamp"],
  ] as const).map(([kind, column, type]): Case => ({ kind, host: REPORT, view: "v_week_stats", column, retyped: cast(type) })),
];

async function load(host: unknown, programFields: unknown[] = []): Promise<MetaRoot> {
  const json = JSON.stringify({
    "metadata.root": { package: "acme", children: [program(programFields), WEEK, WEEK_BRIEF, host] },
  });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  return root;
}

async function applyRaw(text: string, db: Db = k): Promise<void> {
  for (const stmt of text.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(db);
  }
}

interface Model { expected: SchemaSnapshot; view: ViewDescriptor }

/** The expected schema of a model, and the one view under test. */
async function model(host: unknown, viewName: string, programFields: unknown[] = []): Promise<Model> {
  const root = await load(host, programFields);
  const expected = buildExpectedSchema(root, {
    columnNamingStrategy: STRATEGY,
    views: buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: STRATEGY }),
  });
  const view = expected.views.find((v) => v.name === viewName);
  if (view === undefined) throw new Error(`no view '${viewName}' was derived`);
  return { expected, view };
}

/** A plan on the live path: introspect, then diff with the probe. `probe: null` plans offline-style, with none. */
async function plan(expected: SchemaSnapshot, allow: AllowOptions = {}, probe: ViewReplaceProbe | null = postgresViewReplaceProbe(k)) {
  return diff({
    expected, actual: await introspectPostgres(k), dialect: "postgres", allow,
    ...(probe !== null ? { viewReplaceProbe: probe } : {}),
  });
}

async function apply(changes: Awaited<ReturnType<typeof plan>>["changes"]): Promise<string> {
  const { up } = emit(changes, { dialect: "postgres" });
  await applyRaw(up);
  return up;
}

/** Create the model's tables and no view: the state a hand-written view is created in. */
async function createTables(expected: SchemaSnapshot): Promise<void> {
  const tables = await plan({ ...expected, views: [] });
  expect(tables.blocked).toEqual([]);
  await apply(tables.changes);
}

/** The whole model, views included and stamped. */
async function migrate(expected: SchemaSnapshot): Promise<void> {
  const all = await plan(expected);
  expect(all.blocked).toEqual([]);
  await apply(all.changes);
  expect((await plan(expected)).changes).toEqual([]);
}

/** The column names of the derived body, in order, as Postgres reports them. */
async function columnNames(view: ViewDescriptor): Promise<string[]> {
  await sql.raw(`CREATE VIEW "mo_column_names" AS ${view.sql}`).execute(k);
  const r = await sql.raw(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'mo_column_names' ORDER BY ordinal_position`,
  ).execute(k);
  await sql.raw(`DROP VIEW "mo_column_names"`).execute(k);
  return (r.rows as { column_name: string }[]).map((row) => row.column_name);
}

/**
 * Create a view somebody wrote by hand: other SQL, the derived view's column names in its
 * order. `retype` gives one column another type; `withoutLast` leaves the last column out.
 */
async function createHandWritten(
  view: ViewDescriptor,
  shape: { retype?: Pick<Case, "column" | "retyped">; withoutLast?: true } = {},
): Promise<void> {
  const all = await columnNames(view);
  const names = shape.withoutLast === true ? all.slice(0, -1) : all;
  expect(names.length).toBeGreaterThan(0);
  if (shape.retype !== undefined) expect(names).toContain(shape.retype.column);
  const columns = names.map((name) => {
    const ref = `q."${name}"`;
    return shape.retype?.column === name ? `${shape.retype.retyped(ref)} AS "${name}"` : ref;
  });
  await sql.raw(`CREATE VIEW "${view.name}" AS SELECT ${columns.join(", ")} FROM (${view.sql}) q`).execute(k);
}

async function scalar(query: string, db: Db = k): Promise<unknown> {
  const r = await sql.raw(query).execute(db);
  return Object.values(r.rows[0] as Record<string, unknown>)[0];
}
const viewOid = (name: string) => scalar(`SELECT 'public."${name}"'::regclass::oid::text`);
const viewComment = (name: string) => scalar(`SELECT obj_description('public."${name}"'::regclass, 'pg_class')`);
const probeRelations = (db: Db = k) => scalar(`SELECT count(*)::int FROM pg_class WHERE relname = '${PROBE_RELATION}'`, db);
const columnTypes = async (name: string): Promise<Record<string, string>> => {
  const r = await sql.raw(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
      WHERE a.attrelid = 'public."${name}"'::regclass AND a.attnum > 0 ORDER BY a.attnum`,
  ).execute(k);
  return Object.fromEntries((r.rows as { attname: string; type: string }[]).map((row) => [row.attname, row.type]));
};

const STAMP = /^metaobjects:v1:sha256:[0-9a-f]{64}$/;
const kindsOf = (changes: readonly { kind: string }[]): string[] => changes.map((c) => c.kind).sort();
const refusesReplace = (view: ViewDescriptor) =>
  expect(sql.raw(`CREATE OR REPLACE VIEW "${view.name}" AS ${view.sql}`).execute(k)).rejects.toThrow(
    /cannot (change data type|change name|drop columns)/,
  );

describe("adopting a hand-written view (postgres)", () => {
  for (const c of CASES) {
    describe(c.kind, () => {
      test("the same columns: replaced in place", async () => {
        const { expected, view } = await model(c.host, c.view);
        await createTables(expected);
        await createHandWritten(view);
        const before = await viewOid(c.view);

        // Unfingerprinted, so the adoption is gated whichever way it is planned.
        expect(kindsOf((await plan(expected)).blocked)).toEqual(["replace-view"]);

        const adopted = await plan(expected, { adoptView: true });
        expect(adopted.blocked).toEqual([]);
        expect(kindsOf(adopted.changes)).toEqual(["replace-view"]);
        expect(await apply(adopted.changes)).toContain(`CREATE OR REPLACE VIEW "${c.view}" AS`);

        // The same view object: nothing was dropped.
        expect(await viewOid(c.view)).toBe(before);
        expect(await viewComment(c.view)).toMatch(STAMP);
        expect((await plan(expected)).changes).toEqual([]);
      }, 60_000);

      test("the derived view appends a column: replaced in place", async () => {
        const { expected, view } = await model(c.host, c.view);
        await createTables(expected);
        await createHandWritten(view, { withoutLast: true });
        const before = await viewOid(c.view);

        const adopted = await plan(expected, { adoptView: true });
        expect(adopted.blocked).toEqual([]);
        expect(kindsOf(adopted.changes)).toEqual(["replace-view"]);
        // Undoing an append removes a column, which a replace cannot do.
        expect(adopted.changes[0]).toMatchObject({ proven: { restorable: false } });
        await apply(adopted.changes);

        expect(await viewOid(c.view)).toBe(before);
        expect((await plan(expected)).changes).toEqual([]);
      }, 60_000);

      test("one column of another type: dropped and created", async () => {
        const { expected, view } = await model(c.host, c.view);
        await createTables(expected);
        await createHandWritten(view, { retype: c });

        // Postgres will not replace this view with the derived one.
        await refusesReplace(view);

        expect(kindsOf((await plan(expected)).blocked)).toContain("drop-view");

        const adopted = await plan(expected, { adoptView: true });
        expect(adopted.blocked).toEqual([]);
        expect(kindsOf(adopted.changes)).toEqual(["create-view", "drop-view"]);
        expect(await apply(adopted.changes)).not.toContain("CREATE OR REPLACE");

        expect(await viewComment(c.view)).toMatch(STAMP);
        expect((await plan(expected)).changes).toEqual([]);
      }, 60_000);
    });
  }
});

describe("changing a managed view (postgres)", () => {
  // A stamped projection whose coalesce moves from a varchar(40) field to an unbounded one.
  // The column keeps its name and is still a string, and its type goes from character
  // varying to text.
  test("a column whose type changes is dropped and created, and applies", async () => {
    const before = await model(summary(COALESCE_NICKNAME), SUMMARY_VIEW);
    await migrate(before.expected);
    expect(await columnTypes(SUMMARY_VIEW)).toEqual({ id: "bigint", displayName: "character varying" });

    const after = await model(summary(COALESCE_NOTES), SUMMARY_VIEW);
    await refusesReplace(after.view);

    const changed = await plan(after.expected);
    expect(changed.blocked).toEqual([]);
    expect(kindsOf(changed.changes)).toEqual(["create-view", "drop-view"]);
    await apply(changed.changes);

    expect(await columnTypes(SUMMARY_VIEW)).toEqual({ id: "bigint", displayName: "text" });
    expect((await plan(after.expected)).changes).toEqual([]);
  }, 60_000);

  test("an appended field is replaced in place, and the down migration drops and recreates", async () => {
    const before = await model(summary(COALESCE_NICKNAME), SUMMARY_VIEW);
    await migrate(before.expected);
    const oid = await viewOid(SUMMARY_VIEW);

    const after = await model(
      summary(COALESCE_NICKNAME, computed("isNamed", "boolean", { op: "isNotNull", arg: { field: "nickname" } })),
      SUMMARY_VIEW,
    );
    const changed = await plan(after.expected);
    expect(kindsOf(changed.changes)).toEqual(["replace-view"]);
    const { up, down } = emit(changed.changes, { dialect: "postgres" });
    await applyRaw(up);
    expect(await viewOid(SUMMARY_VIEW)).toBe(oid);
    expect(Object.keys(await columnTypes(SUMMARY_VIEW))).toEqual(["id", "displayName", "isNamed"]);

    // The down removes a column: Postgres refuses that as a replace, so it is a drop and a create.
    expect(down).not.toContain("CREATE OR REPLACE");
    await applyRaw(down);
    expect(Object.keys(await columnTypes(SUMMARY_VIEW))).toEqual(["id", "displayName"]);
    expect((await plan(before.expected)).changes).toEqual([]);
  }, 60_000);

  test("a change that keeps every column is replaced in place, and so is its down migration", async () => {
    const before = await model(summary(computed("flag", "boolean", { op: "isNull", arg: { field: "nickname" } })), SUMMARY_VIEW);
    await migrate(before.expected);
    const oid = await viewOid(SUMMARY_VIEW);

    const after = await model(summary(computed("flag", "boolean", { op: "isNull", arg: { field: "notes" } })), SUMMARY_VIEW);
    const changed = await plan(after.expected);
    expect(kindsOf(changed.changes)).toEqual(["replace-view"]);
    expect(changed.changes[0]).toMatchObject({ proven: { restorable: true } });
    const { up, down } = emit(changed.changes, { dialect: "postgres" });
    await applyRaw(up);
    expect(await viewOid(SUMMARY_VIEW)).toBe(oid);

    expect(down).toContain(`CREATE OR REPLACE VIEW "${SUMMARY_VIEW}" AS`);
    await applyRaw(down);
    expect(await viewOid(SUMMARY_VIEW)).toBe(oid);
    expect((await plan(before.expected)).changes).toEqual([]);
  }, 60_000);
});

// The probe sees the schema as it stands; the replace runs after the plan's table changes.
// A hand-written `@sql` body with `SELECT *` re-expands then, so a column the same plan adds
// lands in the middle of the view's column list.
describe("an @sql body that reads every column (postgres)", () => {
  const starBody = (extra: number): string => `SELECT p.*, ${extra} AS "extra" FROM "programs" p`;
  const starView = (extra: number): unknown => ({
    "object.projection": { name: "ProgramSummary", children: [
      { "source.rdb": { "@kind": "view", "@view": SUMMARY_VIEW, "@sql": starBody(extra) } },
      { "identity.primary": { name: "id", extends: "Program.id", "@fields": "id" } },
      { "field.long": { name: "id", extends: "Program.id" } },
    ] },
  });
  const TAGLINE = [{ "field.string": { name: "tagline" } }];

  test("a body change beside an added column is dropped and created, and applies", async () => {
    await migrate((await model(starView(1), SUMMARY_VIEW)).expected);
    const after = await model(starView(2), SUMMARY_VIEW, TAGLINE);

    // Postgres accepts the replace today and refuses it once the column exists.
    const rollback = new Error("rollback");
    await expect(k.transaction().execute(async (trx) => {
      await sql.raw(`CREATE OR REPLACE VIEW "${SUMMARY_VIEW}" AS ${after.view.sql}`).execute(trx);
      throw rollback;
    })).rejects.toBe(rollback);
    await expect(k.transaction().execute(async (trx) => {
      await sql.raw(`ALTER TABLE "programs" ADD COLUMN "tagline" TEXT`).execute(trx);
      await sql.raw(`CREATE OR REPLACE VIEW "${SUMMARY_VIEW}" AS ${after.view.sql}`).execute(trx);
    })).rejects.toThrow(/cannot change name of view column "extra" to "tagline"/);

    const changed = await plan(after.expected);
    expect(changed.blocked).toEqual([]);
    expect(kindsOf(changed.changes)).toEqual(["add-column", "create-view", "drop-view"]);
    await apply(changed.changes);

    expect(Object.keys(await columnTypes(SUMMARY_VIEW))).toEqual(["id", "status", "nickname", "notes", "tagline", "extra"]);
    expect((await plan(after.expected)).changes).toEqual([]);
  }, 60_000);

  test("a body change with no added column is replaced in place", async () => {
    await migrate((await model(starView(1), SUMMARY_VIEW)).expected);
    const oid = await viewOid(SUMMARY_VIEW);
    const after = await model(starView(2), SUMMARY_VIEW);

    const changed = await plan(after.expected);
    expect(kindsOf(changed.changes)).toEqual(["replace-view"]);
    await apply(changed.changes);
    expect(await viewOid(SUMMARY_VIEW)).toBe(oid);
    expect((await plan(after.expected)).changes).toEqual([]);
  }, 60_000);
});

describe("when the probe cannot answer, the plan is a drop and a create (postgres)", () => {
  const compatible = async (): Promise<Model> => {
    const m = await model(summary(COALESCE_NICKNAME), SUMMARY_VIEW);
    await createTables(m.expected);
    await createHandWritten(m.view);
    return m;
  };

  test("no probe at all (an offline plan)", async () => {
    const { expected } = await compatible();
    const adopted = await plan(expected, { adoptView: true }, null);
    expect(kindsOf(adopted.changes)).toEqual(["create-view", "drop-view"]);
    await apply(adopted.changes);
    expect((await plan(expected)).changes).toEqual([]);
  }, 60_000);

  // The new definition reads a column the same migration adds, so it does not compile
  // against the schema as it stands.
  test("the expected definition does not compile yet", async () => {
    const before = await model(summary(COALESCE_NICKNAME), SUMMARY_VIEW);
    await migrate(before.expected);

    const after = await model(
      summary(COALESCE_NICKNAME, { "field.string": { name: "tagline", children: [{ "origin.passthrough": { "@from": "Program.tagline" } }] } }),
      SUMMARY_VIEW,
      [{ "field.string": { name: "tagline" } }],
    );
    const live = (await introspectPostgres(k)).views.find((v) => v.name === SUMMARY_VIEW)!;
    expect(await postgresViewReplaceProbe(k)(after.view, live)).toBeUndefined();

    const changed = await plan(after.expected);
    expect(changed.blocked).toEqual([]);
    expect(kindsOf(changed.changes)).toEqual(["add-column", "create-view", "drop-view"]);
    await apply(changed.changes);
    expect((await plan(after.expected)).changes).toEqual([]);
  }, 60_000);

  test("the connection may not create a temporary view", async () => {
    const { expected, view } = await compatible();
    const role = `mo_limited_${randomUUID().slice(0, 8)}`;
    const database = String(await scalar("SELECT current_database()"));
    await sql.raw(`CREATE ROLE "${role}" LOGIN PASSWORD 'limited'`).execute(k);
    await sql.raw(`REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC`).execute(k);
    await sql.raw(`GRANT USAGE ON SCHEMA public TO "${role}"`).execute(k);
    await sql.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`).execute(k);
    const uri = new URL(pg.connectionUri);
    uri.username = role;
    uri.password = "limited";
    const limited = connect(uri.toString());
    try {
      const live = (await introspectPostgres(k)).views.find((v) => v.name === SUMMARY_VIEW)!;
      // It can read the model's tables, so only the temporary view is refused.
      expect(await scalar(`SELECT count(*)::int FROM "programs"`, limited)).toBe(0);
      expect(await postgresViewReplaceProbe(limited)(view, live)).toBeUndefined();

      const adopted = await plan(expected, { adoptView: true }, postgresViewReplaceProbe(limited));
      expect(kindsOf(adopted.changes)).toEqual(["create-view", "drop-view"]);
      await apply(adopted.changes);
      expect((await plan(expected)).changes).toEqual([]);
    } finally {
      await limited.destroy();
      await sql.raw(`GRANT TEMPORARY ON DATABASE "${database}" TO PUBLIC`).execute(k);
      await sql.raw(`DROP OWNED BY "${role}"`).execute(k);
      await sql.raw(`DROP ROLE "${role}"`).execute(k);
    }
  }, 60_000);
});

describe("the probe itself (postgres)", () => {
  const TYPED_VIEW = `SELECT p."id", p."nickname", CAST(NULL AS jsonb) AS "doc", CAST(NULL AS json) AS "raw",
      CAST(1 AS smallint) AS "small", CAST(NULL AS text[]) AS "names", CAST(1 AS numeric(9,2)) AS "price"
    FROM "programs" p`;

  /** A stamped derived view, and a second definition of it to ask the probe about. */
  async function arranged(): Promise<{ expected: ViewDescriptor; live: ViewDescriptor }> {
    const m = await model(summary(COALESCE_NICKNAME), SUMMARY_VIEW);
    await migrate(m.expected);
    const live = (await introspectPostgres(k)).views.find((v) => v.name === SUMMARY_VIEW)!;
    return { expected: { name: SUMMARY_VIEW, sql: TYPED_VIEW }, live };
  }

  test("reports each view's exact column names and types, in order", async () => {
    const { expected, live } = await arranged();
    const evidence = await postgresViewReplaceProbe(k)(expected, live);
    expect(evidence?.expected.map((c) => [c.name, c.type])).toEqual([
      ["id", "bigint"],
      ["nickname", "character varying(40)"],
      ["doc", "jsonb"],
      ["raw", "json"],
      ["small", "smallint"],
      ["names", "text[]"],
      ["price", "numeric(9,2)"],
    ]);
    expect(evidence?.live.map((c) => [c.name, c.type])).toEqual([
      ["id", "bigint"],
      ["displayName", "character varying"],
    ]);
  }, 60_000);

  test("leaves nothing behind, whether it answers or not", async () => {
    const { expected, live } = await arranged();
    const oid = await viewOid(SUMMARY_VIEW);
    const comment = await viewComment(SUMMARY_VIEW);
    const relations = await scalar(`SELECT count(*)::int FROM pg_class`);

    expect(await postgresViewReplaceProbe(k)(expected, live)).toBeDefined();
    expect(await postgresViewReplaceProbe(k)({ name: SUMMARY_VIEW, sql: `SELECT "nope" FROM "programs"` }, live)).toBeUndefined();
    expect(await postgresViewReplaceProbe(k)({ name: SUMMARY_VIEW }, live)).toBeUndefined();

    expect(await probeRelations()).toBe(0);
    expect(await scalar(`SELECT count(*)::int FROM pg_class`)).toBe(relations);
    expect(await viewOid(SUMMARY_VIEW)).toBe(oid);
    expect(await viewComment(SUMMARY_VIEW)).toBe(comment);
  }, 60_000);

  // A caller that plans inside its own transaction: the probe must undo only its own work,
  // and a probe that fails must not abort the caller's transaction.
  test("inside a caller's open transaction it uses a savepoint and leaves the transaction usable", async () => {
    const { expected, live } = await arranged();
    await k.transaction().execute(async (trx) => {
      await sql.raw(`INSERT INTO "programs" ("id", "status") VALUES (7, 'DRAFT')`).execute(trx);

      const evidence = await postgresViewReplaceProbe(trx)(expected, live);
      expect(evidence?.expected.map((c) => c.name)).toEqual(["id", "nickname", "doc", "raw", "small", "names", "price"]);
      expect(await probeRelations(trx)).toBe(0);
      expect(await scalar(`SELECT count(*)::int FROM "programs"`, trx)).toBe(1);

      // A statement that fails aborts a Postgres transaction unless it is inside a savepoint.
      expect(await postgresViewReplaceProbe(trx)({ name: SUMMARY_VIEW, sql: `SELECT "nope" FROM "programs"` }, live)).toBeUndefined();
      expect(await scalar(`SELECT count(*)::int FROM "programs"`, trx)).toBe(1);
      await sql.raw(`INSERT INTO "programs" ("id", "status") VALUES (8, 'DRAFT')`).execute(trx);
    });
    // The caller's own work committed; the probe's did not.
    expect(await scalar(`SELECT count(*)::int FROM "programs"`)).toBe(2);
    expect(await probeRelations()).toBe(0);
  }, 60_000);

  test("a caller's transaction that rolls back takes nothing of the probe's with it but its own work", async () => {
    const { expected, live } = await arranged();
    const rollback = new Error("rollback");
    await expect(k.transaction().execute(async (trx) => {
      await sql.raw(`INSERT INTO "programs" ("id", "status") VALUES (9, 'DRAFT')`).execute(trx);
      expect(await postgresViewReplaceProbe(trx)(expected, live)).toBeDefined();
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await scalar(`SELECT count(*)::int FROM "programs"`)).toBe(0);
    expect(await probeRelations()).toBe(0);
    expect(await viewComment(SUMMARY_VIEW)).toMatch(STAMP);
  }, 60_000);
});
