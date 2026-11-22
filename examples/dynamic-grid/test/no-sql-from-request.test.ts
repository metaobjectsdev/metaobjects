/**
 * No SQL is built from request text.
 *
 * The proof is taken at the database driver: every statement the server sends is captured
 * as its SQL text and its bound values, separately. Text from the request must never be in
 * the SQL text. It either arrives as a bound value or the request is refused before any
 * statement is sent.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { openDemo, type Demo } from "./helpers";

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const statements: Statement[] = [];
let demo: Demo;

beforeAll(async () => {
  demo = await openDemo({ onStatement: (sql, parameters) => statements.push({ sql, parameters }) });
});
afterAll(async () => {
  await demo.close();
});
beforeEach(() => {
  statements.length = 0;
});

/**
 * A marker no schema name contains, so finding it in SQL text can only mean it was spliced in.
 * It holds no LIKE or GLOB wildcard (`%`, `_`, `*`, `?`, `[`): `like` is lowered to `glob` on
 * SQLite and rewrites those, so a wildcard would change the bound value.
 */
const MARKER = "zzmarkerzz";
const ATTACK = `${MARKER}'; DROP TABLE customers; --`;
const q = encodeURIComponent;

async function customerCount(): Promise<number> {
  return demo.runtime.current().om.count("Customer");
}

function expectNotInSql(): void {
  for (const statement of statements) expect(statement.sql).not.toContain(MARKER);
}

test("a filter value is bound, never spliced into the statement", async () => {
  const before = await customerCount();
  statements.length = 0;
  const res = await demo.get(`/api/customers?filter[name]=${q(ATTACK)}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
  expect(statements.length).toBeGreaterThan(0);
  expectNotInSql();
  expect(statements.some((s) => s.parameters.includes(ATTACK))).toBe(true);
  expect(await customerCount()).toBe(before);
});

test("like and in values are bound too", async () => {
  expect((await demo.get(`/api/customers?filter[name][like]=${q(ATTACK)}`)).status).toBe(200);
  const likeStatements = statements.splice(0);
  expect((await demo.get(`/api/customers?filter[name][in]=${q(`a,${ATTACK}`)}`)).status).toBe(200);
  const inStatements = statements.splice(0);
  for (const sent of [likeStatements, inStatements]) {
    for (const statement of sent) expect(statement.sql).not.toContain(MARKER);
    expect(sent.filter((s) => s.parameters.some((p) => typeof p === "string" && p.includes(MARKER))).length).toBe(1);
    // The bound value reaches the driver unchanged.
    expect(sent.some((s) => s.parameters.some((p) => p === ATTACK))).toBe(true);
  }
});

test("a field name the model does not declare is refused before any statement is sent", async () => {
  const res = await demo.get(`/api/customers?filter[${q(`name) OR 1=1; -- ${MARKER}`)}]=x`);
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({ error: "invalid_filter_field" });
  expect(statements).toEqual([]);
});

test("an operator outside the closed set is refused before any statement is sent", async () => {
  const res = await demo.get(`/api/customers?filter[name][${q(`eq) OR 1=1; -- ${MARKER}`)}]=x`);
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({ error: "invalid_filter_op", field: "name" });
  expect(statements).toEqual([]);
});

test("a sort field or order outside the allowlist is refused before any statement is sent", async () => {
  for (const sort of [`name; DROP TABLE customers; -- ${MARKER}`, `name:asc; DROP TABLE customers; -- ${MARKER}`, `(SELECT 1) ${MARKER}`]) {
    const res = await demo.get(`/api/customers?sort=${q(sort)}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_sort" });
  }
  expect(statements).toEqual([]);
});

test("limit and offset must be plain non-negative integers", async () => {
  for (const [param, value] of [["limit", `1; DROP TABLE customers; -- ${MARKER}`], ["offset", `0 UNION SELECT 1 ${MARKER}`], ["limit", "-1"], ["offset", "1e3"]] as const) {
    const res = await demo.get(`/api/customers?${param}=${q(value)}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "pagination.invalid_value", param, value, expected: "a non-negative integer (0 or more)" });
  }
  expect(statements).toEqual([]);
});

test("a collection name is looked up in the model, never used as a table name", async () => {
  const res = await demo.get(`/api/${q(`customers; DROP TABLE customers; -- ${MARKER}`)}`);
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: "not_found" });
  // `sqlite_master` exists in the database, but it is not in the model, so it is not served.
  expect((await demo.get("/api/sqlite_master")).status).toBe(404);
  expect(statements).toEqual([]);
});

test("an id in the path is bound, and a hostile one deletes nothing", async () => {
  const before = await customerCount();
  statements.length = 0;
  const hostile = q(`1 OR 1=1 ${MARKER}`);
  expect((await demo.get(`/api/customers/${hostile}`)).status).toBe(404);
  expect((await demo.send("DELETE", `/api/customers/${hostile}`)).status).toBe(404);
  expect((await demo.send("PATCH", `/api/customers/${hostile}`, { name: "x" })).status).toBe(404);
  expectNotInSql();
  expect(await customerCount()).toBe(before);
});

test("a write body's values are bound, and its keys are checked against the model first", async () => {
  const created = await demo.send("POST", "/api/customers", { name: ATTACK });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ name: ATTACK });
  expectNotInSql();
  expect(statements.some((s) => s.parameters.includes(ATTACK))).toBe(true);

  statements.length = 0;
  const refused = await demo.send("POST", "/api/customers", { name: "ok", [`name") VALUES ('x'); -- ${MARKER}`]: 1 });
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({ error: "unknown_fields" });
  expect(statements).toEqual([]);
});

test("every table is still there afterwards", async () => {
  for (const collection of demo.runtime.current().served.keys()) {
    expect((await demo.get(`/api/${collection}?limit=1`)).status).toBe(200);
  }
});
