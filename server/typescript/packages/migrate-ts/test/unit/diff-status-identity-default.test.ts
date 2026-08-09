/**
 * PR #279 stopped `meta migrate` from proposing a destructive
 * `ALTER COLUMN "id" DROP DEFAULT` against a live Postgres `serial` PK — but
 * ONLY when the metadata explicitly declares `identity.primary
 * @generation: increment`. `buildExpectedSchema` sets `ColumnDescriptor.identity`
 * exclusively from a declared `@generation` (expected-schema.ts) — there is no
 * default — so an adopter who writes `identity.primary` with NO `@generation`
 * against a live `serial` PK gets `ec.identity === undefined`, the #279 guard
 * (diff/index.ts's `skipIdentityDefaultDiff`) never engages, and the same
 * destructive drop reaches the diff as an ordinary, ALLOWED
 * `change-column-default`.
 *
 * We deliberately do NOT widen the #279 guard to key off the LIVE column
 * instead: "no @generation declared" is genuinely ambiguous between "never
 * got around to declaring it" and "deliberately moving off auto-increment"
 * (e.g. onto app-assigned ULIDs) — the diff cannot tell those apart, so
 * instead of guessing it must ask. This is the same shape as #258 (refuse a
 * PK move rather than emit an un-appliable migration).
 *
 * This suite covers the blocking case, the `--allow drop-identity-default`
 * escape hatch that makes the deliberate-removal path still work, and three
 * no-churn guards: the #279 explicit-`@generation` path stays a total no-op
 * (not merely "allowed"), an ordinary (non-auto-sequence) default change
 * stays allowed, and a `uuid`-identity PK is unaffected.
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import type { ColumnDescriptor, SchemaSnapshot } from "../../src/types.js";

function snap(col: ColumnDescriptor): SchemaSnapshot {
  return {
    tables: [{ name: "work_item", columns: [col], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] }],
    views: [],
  };
}

// No `identity` at all — the shape `buildExpectedSchema` produces when
// `identity.primary` is declared WITHOUT `@generation`.
const expectedNoGeneration: ColumnDescriptor = {
  name: "id", sqlType: { kind: "integer", bits: 32 }, nullable: false,
};

const liveAutoSequence: ColumnDescriptor = {
  name: "id", sqlType: { kind: "integer", bits: 32 }, nullable: false, identity: "increment",
  default: { kind: "expr", value: "nextval('work_item_id_seq'::regclass)" },
};

describe("diff — undeclared @generation against a live serial PK refuses, not guesses", () => {
  test("RED: blocked, with a reason naming both remedies", async () => {
    const r = await diff(snap(expectedNoGeneration), snap(liveAutoSequence), { dialect: "postgres" });
    const change = r.changes.find((c) => c.kind === "change-column-default");
    expect(change).toBeDefined();
    expect(change!.status.state).toBe("blocked");
    expect(r.blocked).toContain(change!);

    const reason = change!.status.blockedReason ?? "";
    expect(reason).toContain("work_item");
    expect(reason).toContain("id");
    // Remedy 1: keep the sequence.
    expect(reason).toContain("@generation: increment");
    // Remedy 2: the allow-flag escape.
    expect(reason).toContain("--allow drop-identity-default");
  });

  test("RED: allow.dropIdentityDefault lets the deliberate removal through", async () => {
    const r = await diff(snap(expectedNoGeneration), snap(liveAutoSequence), {
      dialect: "postgres",
      allow: { dropIdentityDefault: true },
    });
    const change = r.changes.find((c) => c.kind === "change-column-default");
    expect(change).toBeDefined();
    expect(change!.status.state).toBe("allowed");
    expect(r.blocked).toHaveLength(0);
  });

  test("no-churn (a): the #279 explicit @generation: increment path is a total no-op, not merely allowed", async () => {
    const expectedIncrementPk: ColumnDescriptor = {
      name: "id", sqlType: { kind: "integer", bits: 32 }, nullable: false, identity: "increment",
    };
    const r = await diff(snap(expectedIncrementPk), snap(liveAutoSequence), { dialect: "postgres" });
    expect(r.changes).toEqual([]);
    expect(r.blocked).toHaveLength(0);
  });

  test("no-churn (b): an ordinary default change ('0' -> '1') stays allowed", async () => {
    const expected: ColumnDescriptor = {
      name: "n", sqlType: { kind: "integer", bits: 32 }, nullable: false,
      default: { kind: "literal", value: "1" },
    };
    const actual: ColumnDescriptor = {
      name: "n", sqlType: { kind: "integer", bits: 32 }, nullable: false,
      default: { kind: "literal", value: "0" },
    };
    const r = await diff(snap(expected), snap(actual), { dialect: "postgres" });
    const change = r.changes.find((c) => c.kind === "change-column-default");
    expect(change).toBeDefined();
    expect(change!.status.state).toBe("allowed");
    expect(r.blocked).toHaveLength(0);
  });

  test("no-churn (b): dropping a plain LITERAL default (not an auto-sequence) stays allowed", async () => {
    const expected: ColumnDescriptor = {
      name: "n", sqlType: { kind: "integer", bits: 32 }, nullable: false,
    };
    const actual: ColumnDescriptor = {
      name: "n", sqlType: { kind: "integer", bits: 32 }, nullable: false,
      default: { kind: "literal", value: "0" },
    };
    const r = await diff(snap(expected), snap(actual), { dialect: "postgres" });
    const change = r.changes.find((c) => c.kind === "change-column-default");
    expect(change).toBeDefined();
    expect(change!.status.state).toBe("allowed");
    expect(r.blocked).toHaveLength(0);
  });

  test("no-churn (b): dropping a non-sequence EXPR default stays allowed (only nextval(...) is gated)", async () => {
    const expected: ColumnDescriptor = {
      name: "n", sqlType: { kind: "timestamp", withTimezone: false }, nullable: false,
    };
    const actual: ColumnDescriptor = {
      name: "n", sqlType: { kind: "timestamp", withTimezone: false }, nullable: false,
      default: { kind: "expr", value: "now()" },
    };
    const r = await diff(snap(expected), snap(actual), { dialect: "postgres" });
    const change = r.changes.find((c) => c.kind === "change-column-default");
    expect(change).toBeDefined();
    expect(change!.status.state).toBe("allowed");
    expect(r.blocked).toHaveLength(0);
  });

  test("no-churn (c): a uuid-identity PK (declared @generation: uuid) is unaffected", async () => {
    const expectedUuidPk: ColumnDescriptor = {
      name: "id", sqlType: { kind: "uuid" }, nullable: false, identity: "uuid",
    };
    const actual: ColumnDescriptor = {
      ...expectedUuidPk,
      default: { kind: "expr", value: "gen_random_uuid()" },
    };
    const r = await diff(snap(expectedUuidPk), snap(actual), { dialect: "postgres" });
    expect(r.changes).toEqual([]);
    expect(r.blocked).toHaveLength(0);
  });
});
