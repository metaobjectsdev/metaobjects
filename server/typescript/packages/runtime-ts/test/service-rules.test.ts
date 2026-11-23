// The business-rules mechanics a generated service shell calls (ADR-0066 §6): the permission
// point, the state check, the guarded update and its re-read, the state-managed refusal and the
// business refusal. libsql on a scratch file, as in service.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCreateState,
  checkPermission,
  checkState,
  checkStateManaged,
  emitWrite,
  inWriteTransaction,
  keyCondition,
  makeTransition,
  refuseBusiness,
  type OpResult,
  type TransitionSpec,
  type WriteEvent,
} from "../src/service/index.js";

const requests = sqliteTable("requests", {
  id: integer("id").primaryKey(),
  status: text("status").notNull(),
  amount: integer("amount"),
  limitAmount: integer("limit_amount"),
});

let dir: string;
let client: Client;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  dir = mkdtempSync(join(process.env.DEV_SCRATCH ?? tmpdir(), "runtime-ts-service-rules-"));
  client = createClient({ url: `file:${join(dir, "rules.db")}` });
  db = drizzle(client);
  await client.execute("CREATE TABLE requests (id INTEGER PRIMARY KEY, status TEXT NOT NULL, amount INTEGER, limit_amount INTEGER)");
});

afterAll(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.execute("DELETE FROM requests");
  await client.execute(
    "INSERT INTO requests (id, status, amount, limit_amount) VALUES (1, 'submitted', 50, 100), (2, 'submitted', 500, 100), (3, 'draft', 50, NULL)",
  );
});

const status = async (id: number) => (await client.execute(`SELECT status FROM requests WHERE id = ${id}`)).rows[0]?.["status"];

function failed<T>(r: OpResult<T>): { status: number; error: Record<string, unknown> } {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.value)}`);
  return r;
}

// approve: submitted → approved, when amount <= coalesce(limitAmount, 0) and not (amount is null).
const approve: TransitionSpec = {
  name: "approve",
  field: "status",
  from: ["submitted"],
  to: "approved",
  condition: {
    op: "and",
    args: [
      { op: "lte", left: { field: "amount" }, right: { fn: "coalesce", args: [{ field: "limitAmount" }, { value: 0 }] } },
      { op: "not", arg: { op: "isNull", arg: { field: "amount" } } },
    ],
  },
};

const move = (id: number, t: TransitionSpec) =>
  inWriteTransaction(db, undefined, (tx) => makeTransition(tx, requests, keyCondition(requests, "id", id), t, "sqlite"));

describe("makeTransition — the guarded update", () => {
  test("a row in a from state whose condition holds moves, and the written row is answered", async () => {
    const r = await move(1, approve);
    expect(r).toEqual({ ok: true, value: { id: 1, status: "approved", amount: 50, limitAmount: 100 } });
  });

  test("a failing condition is transition_condition_failed, and nothing is written", async () => {
    expect(failed(await move(2, approve))).toEqual({ ok: false, status: 409, error: { error: "transition_condition_failed" } } as never);
    expect(await status(2)).toBe("submitted");
  });

  test("another state is invalid_transition", async () => {
    expect(failed(await move(3, approve)).error).toEqual({ error: "invalid_transition" });
  });

  test("the second of two moves out of one state is invalid_transition", async () => {
    expect((await move(1, approve)).ok).toBe(true);
    expect(failed(await move(1, approve)).error).toEqual({ error: "invalid_transition" });
  });

  test("a missing row is not_found", async () => {
    expect(failed(await move(9, approve)).status).toBe(404);
  });

  test("a self-transition matches its row", async () => {
    const touch: TransitionSpec = { name: "touch", field: "status", from: ["submitted"], to: "submitted" };
    expect((await move(1, touch)).ok).toBe(true);
  });
});

describe("the checks before the move", () => {
  test("checkState refuses a row no move starts from", async () => {
    const r = await inWriteTransaction(db, undefined, async () => checkState({ status: "draft" }, [approve]));
    expect(failed(r).error).toEqual({ error: "invalid_transition" });
    expect(() => checkState({ status: "submitted" }, [approve])).not.toThrow();
  });

  test("checkPermission answers 403 forbidden when the policy refuses, with the name, actor, row and input", async () => {
    const seen: unknown[] = [];
    const policy = { allows: (p: string, a: unknown, row: unknown, input: unknown) => (seen.push([p, a, row, input]), a === "ok") };
    const r = await inWriteTransaction(db, undefined, (tx) => checkPermission(policy, "shop.approve", "no", { id: 1 }, { x: 1 }, tx));
    expect(failed(r)).toEqual({ ok: false, status: 403, error: { error: "forbidden" } } as never);
    expect(seen).toEqual([["shop.approve", "no", { id: 1 }, { x: 1 }]]);
  });

  test("checkStateManaged refuses a moved lifecycle field and drops an echoed one", async () => {
    const echoed: Record<string, unknown> = { status: "draft", title: "t" };
    checkStateManaged(echoed, { status: "draft" }, ["status"]);
    expect(echoed).toEqual({ title: "t" });
    const r = await inWriteTransaction(db, undefined, async () => checkStateManaged({ status: "approved" }, { status: "draft" }, ["status"]));
    expect(failed(r).error).toEqual({ error: "state_managed" });
  });
});

describe("refusals and events", () => {
  test("a business refusal rolls back and answers 409 with its code and details", async () => {
    const r = await inWriteTransaction(db, undefined, async (tx) => {
      await makeTransition(tx, requests, keyCondition(requests, "id", 1), approve, "sqlite");
      refuseBusiness("over_budget", { limit: 100 });
    });
    expect(failed(r)).toEqual({ ok: false, status: 409, error: { limit: 100, error: "over_budget" } } as never);
    expect(await status(1)).toBe("submitted");
  });

  test("a reserved or malformed code is a programming error, not a refusal", () => {
    expect(() => refuseBusiness("forbidden")).toThrow(/business refusal/);
    expect(() => refuseBusiness("Over-Budget")).toThrow(/business refusal/);
  });

  test("an event handler runs on the write's transaction, and its refusal undoes the write", async () => {
    const events = {
      onWrite: (e: WriteEvent<string>, ctx: { refuse(code: string): never }) => {
        if (e.kind === "transition" && e.actor === "auditor-down") ctx.refuse("audit_unavailable");
      },
    };
    const r = await inWriteTransaction(db, undefined, async (tx) => {
      await makeTransition(tx, requests, keyCondition(requests, "id", 1), approve, "sqlite");
      await emitWrite(events, { kind: "transition", entity: "Request", key: 1, lifecycle: "status", transition: "approve", from: "submitted", to: "approved", operation: "approveRequest", actor: "auditor-down", at: new Date() }, tx);
    });
    expect(failed(r).error).toEqual({ error: "audit_unavailable" });
    expect(await status(1)).toBe("submitted");
  });
});

describe("checkCreateState", () => {
  test("an omitted state is the initial one, the initial one is kept, another is state_managed", async () => {
    const omitted: Record<string, unknown> = { title: "t" };
    checkCreateState(omitted, { status: "draft" });
    expect(omitted).toEqual({ title: "t", status: "draft" });
    const r = await inWriteTransaction(db, undefined, async () => checkCreateState({ status: "approved" }, { status: "draft" }));
    expect(failed(r).error).toEqual({ error: "state_managed" });
  });
});
