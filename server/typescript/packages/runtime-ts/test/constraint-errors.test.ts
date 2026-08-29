// A2 — a constraint violation must not return 500 with the query and its bound parameters.
//
// A generated CRUD route had no try/catch around its write, so a driver error reached the
// framework's default handler and the caller got:
//
//   HTTP/1.1 500 Internal Server Error
//   {"statusCode":500,"error":"Internal Server Error","message":"Failed query: insert into
//    \"tickets\" (…) values (null, ?, ?, ?, ?, null, ?) …\nparams: 999,x,y,OPEN,2026-…"}
//
// The status is wrong (a client-supplied FK that does not exist is a client error) and the
// body carries the SQL and the bound VALUES — on a POST holding PII or a token, that is
// user data reflected to an unauthenticated caller out of generated code.
//
// Found by POSTing a non-existent customerId to a from-scratch generated app.

import { describe, test, expect } from "bun:test";
import {
  classifyConstraintError,
  withConstraintMapping,
  RedactedDatabaseError,
} from "../src/constraint-errors.js";

/** Verbatim shapes the supported drivers actually throw. */
const SQLITE_FK = Object.assign(new Error("SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed"), {
  code: "SQLITE_CONSTRAINT_FOREIGNKEY",
});
const SQLITE_UNIQUE = Object.assign(
  new Error("SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: customers.email"),
  { code: "SQLITE_CONSTRAINT_UNIQUE" },
);
const PG_FK = Object.assign(new Error('insert or update on table "tickets" violates foreign key constraint'), {
  code: "23503",
});
const PG_UNIQUE = Object.assign(new Error('duplicate key value violates unique constraint'), { code: "23505" });
const PG_CHECK = Object.assign(new Error('new row violates check constraint'), { code: "23514" });

describe("A2 — constraint classification", () => {
  test("recognises foreign-key violations on both engines as 409", () => {
    for (const err of [SQLITE_FK, PG_FK]) {
      const f = classifyConstraintError(err);
      expect(f?.status).toBe(409);
      expect(f?.body).toEqual({ error: "constraint_violation", constraint: "foreign_key" });
    }
  });

  test("recognises unique violations as 409 and check violations as 400", () => {
    expect(classifyConstraintError(SQLITE_UNIQUE)?.status).toBe(409);
    expect(classifyConstraintError(PG_UNIQUE)?.body.constraint).toBe("unique");
    expect(classifyConstraintError(PG_CHECK)?.status).toBe(400);
  });

  test("the response body NEVER carries the query or its parameters", () => {
    // The whole point. Assert on the serialized body, since that is what ships.
    const leaky = Object.assign(
      new Error(
        'Failed query: insert into "tickets" ("id","customer_id") values (null, ?) returning "id"\n' +
          "params: 999,secret@example.test,tok_live_abc123",
      ),
      { code: "SQLITE_CONSTRAINT_FOREIGNKEY" },
    );
    const body = JSON.stringify(classifyConstraintError(leaky)?.body);
    expect(body).not.toContain("insert into");
    expect(body).not.toContain("params");
    expect(body).not.toContain("secret@example.test");
    expect(body).not.toContain("tok_live_abc123");
  });

  test("an unrelated error is NOT misclassified as a constraint problem", () => {
    expect(classifyConstraintError(new Error("connection refused"))).toBeUndefined();
    expect(classifyConstraintError(undefined)).toBeUndefined();
    expect(classifyConstraintError({ nope: true })).toBeUndefined();
  });
});

describe("A2 — the wrapped shape drivers ACTUALLY throw", () => {
  // The first cut of the classifier read only the top-level code+message and therefore
  // matched NOTHING against a real libsql server: Drizzle wraps every driver failure in a
  // DrizzleQueryError whose own message is "Failed query: <sql>\nparams: <values>", with
  // the constraint one level down in `cause`. Captured verbatim from a live server.
  const drizzleWrapped = Object.assign(
    new Error(
      'Failed query: insert into "tickets" ("id","customer_id") values (null, ?)\n' +
        "params: 999,x,y,OPEN",
    ),
    {
      name: "DrizzleQueryError",
      query: 'insert into "tickets" ("id","customer_id") values (null, ?)',
      params: [999, "x", "y", "OPEN"],
      // NOTE the code here is the GENERIC SQLITE_CONSTRAINT, not the extended
      // SQLITE_CONSTRAINT_FOREIGNKEY — the message carries the discriminating word.
      cause: Object.assign(new Error("SQLITE_CONSTRAINT: FOREIGN KEY constraint failed"), {
        code: "SQLITE_CONSTRAINT",
      }),
    },
  );

  test("classifies through the cause chain", () => {
    const f = classifyConstraintError(drizzleWrapped);
    expect(f?.status).toBe(409);
    expect(f?.body.constraint).toBe("foreign_key");
  });

  test("and STILL does not leak the wrapper's query or params", () => {
    const body = JSON.stringify(classifyConstraintError(drizzleWrapped)?.body);
    expect(body).not.toContain("insert into");
    expect(body).not.toContain("999");
  });

  test("survives a self-referential cause without hanging", () => {
    const loop = new Error("weird") as Error & { cause?: unknown };
    loop.cause = loop;
    expect(classifyConstraintError(loop)).toBeUndefined();
  });
});

describe("A2 — withConstraintMapping", () => {
  test("passes a successful write straight through", async () => {
    const out = await withConstraintMapping(async () => "ok", () => "mapped");
    expect(out).toBe("ok");
  });

  test("maps a constraint failure instead of throwing", async () => {
    const out = await withConstraintMapping(
      async () => {
        throw SQLITE_FK;
      },
      (f) => `${f.status}:${f.body.constraint}`,
    );
    expect(out).toBe("409:foreign_key");
  });

  test("an unrecognised driver error is LOGGED in full and rethrown REDACTED", async () => {
    const logged: unknown[] = [];
    await expect(
      withConstraintMapping(
        async () => {
          throw new Error("Failed query: select * from secrets\nparams: tok_live_abc123");
        },
        () => "mapped",
        (e) => logged.push(e),
      ),
    ).rejects.toBeInstanceOf(RedactedDatabaseError);

    // The operator keeps the diagnostic…
    expect(String(logged[0])).toContain("tok_live_abc123");
    // …and the client gets a message with nothing in it.
    const thrown = new RedactedDatabaseError();
    expect(thrown.message).toBe("database error");
    expect(thrown.message).not.toContain("select");
  });
});
