// `decimalColumns` on the read-only mounts: a SQLite REAL under a declared decimal key is
// sent as its string, exactly the spelling Postgres `numeric` and MySQL `DECIMAL` already
// give. Both adapters (Fastify and Hono), plus the pure function they share.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Hono } from "hono";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteView, integer, text } from "drizzle-orm/sqlite-core";
import { decimalWire } from "../src/decimal-wire.js";
import { mountReadOnlyCrudRoutes as mountFastify } from "../src/drizzle-fastify/mount-read-only.js";
import { mountReadOnlyCrudRoutes as mountHono } from "../src/hono/mount-read-only.js";

describe("decimalWire", () => {
  test("nothing to do when no column is named", () => {
    expect(decimalWire(undefined)).toBeUndefined();
    expect(decimalWire([])).toBeUndefined();
  });

  test("a number under a named key becomes its string; everything else passes through", () => {
    const wire = decimalWire(["share", "avg"])!;
    expect(wire({ share: 0.4, avg: 1.6666666666666667, n: 5, label: "a" })).toEqual({
      share: "0.4", avg: "1.6666666666666667", n: 5, label: "a",
    });
    expect(wire({ share: null, avg: "2.50", n: 5 })).toEqual({ share: null, avg: "2.50", n: 5 });
    expect(wire({ n: 5 })).toEqual({ n: 5 });
    expect(wire(null)).toBeNull();
  });

  test("an integer-valued REAL keeps no decimal point, and a key not named stays a number", () => {
    expect(decimalWire(["share"])!({ share: 1, other: 1 })).toEqual({ share: "1", other: 1 });
  });
});

describe("read-only mounts send a named decimal as a string", () => {
  let client: ReturnType<typeof createClient>;
  let fastify: FastifyInstance;
  let hono: Hono;
  let plainFastify: FastifyInstance;

  const view = () => sqliteView("v_shares", {
    kind: text("kind").notNull(),
    n: integer("n").notNull(),
    share: text("share"),
  }).existing();

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    // `share` is a computed REAL, the way a report's ratio is: SQLite gives it back as a number.
    await client.execute(`CREATE TABLE t (kind TEXT NOT NULL, hit INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO t (kind, hit) VALUES ('a', 1), ('a', 0), ('b', 0)`);
    await client.execute(
      `CREATE VIEW v_shares AS SELECT kind, COUNT(*) AS n, CAST(SUM(hit) AS REAL) / NULLIF(COUNT(*), 0) AS share FROM t GROUP BY kind`,
    );
    const db = drizzle(client);
    const base = { path: "/shares", db, view: view(), filterAllowlist: {}, sortAllowlist: {}, dialect: "sqlite" as const, itemRoutes: false, resource: "report" as const };

    fastify = Fastify();
    mountFastify({ fastify, ...base, decimalColumns: ["share"] });
    await fastify.ready();

    plainFastify = Fastify();
    mountFastify({ fastify: plainFastify, ...base });
    await plainFastify.ready();

    hono = new Hono();
    mountHono({ app: hono, ...base, decimalColumns: ["share"] });
  });

  afterAll(async () => {
    await fastify.close();
    await plainFastify.close();
    client.close();
  });

  const expected = [{ kind: "a", n: 2, share: "0.5" }, { kind: "b", n: 1, share: "0" }];
  const byKind = <T extends { kind: string }>(rows: T[]): T[] => [...rows].sort((x, y) => x.kind.localeCompare(y.kind));

  test("fastify", async () => {
    const res = await fastify.inject({ method: "GET", url: "/shares" });
    expect(byKind(JSON.parse(res.body))).toEqual(expected);
  });

  test("fastify, withCount envelope", async () => {
    const res = await fastify.inject({ method: "GET", url: "/shares?withCount=1" });
    const body = JSON.parse(res.body) as { rows: Array<{ kind: string }>; total: number };
    expect(body.total).toBe(2);
    expect(byKind(body.rows)).toEqual(expected);
  });

  test("hono", async () => {
    const res = await hono.request("/shares");
    expect(byKind((await res.json()) as Array<{ kind: string }>)).toEqual(expected);
  });

  test("hono, withCount envelope", async () => {
    const res = await hono.request("/shares?withCount=1");
    const body = (await res.json()) as { rows: Array<{ kind: string }>; total: number };
    expect(body.total).toBe(2);
    expect(byKind(body.rows)).toEqual(expected);
  });

  test("without decimalColumns the mount is unchanged: the REAL reaches the wire as a number", async () => {
    const res = await plainFastify.inject({ method: "GET", url: "/shares" });
    expect(byKind(JSON.parse(res.body))).toEqual([{ kind: "a", n: 2, share: 0.5 }, { kind: "b", n: 1, share: 0 }]);
  });
});
