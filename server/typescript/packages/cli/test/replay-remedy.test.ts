// F58 + F71 — `verify --replay`'s remedy line prescribed something that cannot work.
//
// The old line was unconditional: "fix this with a NEW migration that creates the missing
// object". Migrations apply in timestamp order, so a new one sorts AFTER the file that
// failed and the object is still missing when it runs — the advice is wrong in every case,
// and worse when another tool owns schema creation, where following it literally means
// duplicating a schema this project does not own.
//
// These assert the CLAIMS in the message, because a remedy that names a fix which cannot
// apply is the whole defect. The failure is silent by construction: nothing about a
// wrong-but-confident sentence turns an exit code red.

import { describe, test, expect } from "bun:test";
import { MigrationApplyError } from "@metaobjectsdev/migrate-ts";
import { replayRemedy } from "../src/lib/replay-remedy.js";

const text = (err: unknown): string => replayRemedy(err).join(" ");

describe("replayRemedy", () => {
  test("never prescribes a new migration — the fix that cannot work", () => {
    for (const err of [
      new MigrationApplyError("20260521012518-init", 0, 3, new Error("no such table: purchases")),
      new MigrationApplyError("20260812090000-add-fk", 2, 3, new Error("no such table: purchases")),
      new Error("no such table: purchases"),
    ]) {
      const msg = text(err);
      expect(msg).not.toMatch(/fix this with a NEW migration/i);
      expect(msg).toContain("A NEW migration cannot fix this");
    }
  });

  test("names the failing migration and its position in the chain", () => {
    const msg = text(new MigrationApplyError("20260812090000-add-fk", 2, 5, new Error("boom")));
    expect(msg).toContain("'20260812090000-add-fk'");
    expect(msg).toContain("migration 3 of 5");
  });

  test("F71 — the head of the chain gets the sentence that is only true there", () => {
    const msg = text(new MigrationApplyError("20260521012518-init", 0, 3, new Error("boom")));
    expect(msg).toContain("FIRST migration in the chain");
    expect(msg).toContain("base schema comes from outside it");
  });

  test("a later migration does NOT get the head-of-chain sentence", () => {
    const msg = text(new MigrationApplyError("20260812090000-add-fk", 2, 3, new Error("boom")));
    expect(msg).not.toContain("FIRST migration in the chain");
  });

  test("F58 — offers the possibility that another tool owns schema creation", () => {
    // The estate that produced this has drizzle-kit building the tables and
    // `.metaobjects/migrations/` holding later patches. The old message had no third
    // option: it assumed MetaObjects is the only schema authority.
    const msg = text(new MigrationApplyError("20260521012518-init", 0, 3, new Error("boom")));
    expect(msg).toMatch(/another tool or an out-of-band script owns schema creation/i);
    expect(msg).toContain("don't wire");
  });

  test("immutability is stated as the condition it is, not a blanket ban", () => {
    // A migration no database has applied yet is edited in place every day; the checksum
    // guard is what stops you once one has. The old line forbade the edit outright.
    const msg = text(new MigrationApplyError("20260521012518-init", 0, 1, new Error("boom")));
    expect(msg).toContain("if no database has applied it yet");
    expect(msg).toContain("baseline --from-db");
  });

  test("degrades to the un-positioned form for an error that is not a MigrationApplyError", () => {
    // applyPending can fail before it reaches any file (the checksum tamper guard, a
    // ledger failure). The remedy must still be right, just less specific.
    const msg = text(new Error("ledger unavailable"));
    expect(msg).toContain("the committed chain does not apply to an empty database");
    expect(msg).not.toContain("FIRST migration in the chain");
  });
});

describe("replayRemedy — the error identity", () => {
  test("recognises the engine's error by NAME, across a split package copy", () => {
    // Two physical copies of migrate-ts in one process (a linked global `meta` plus a
    // project-local dependency) give the class and the instance different identities, so
    // `instanceof` returns false for a real error and the remedy silently loses its
    // position — printing the un-positioned form for a head-of-chain failure. Simulated
    // the way `metadata`'s cross-realm test does: a structurally identical error from a
    // foreign "realm".
    class ForeignMigrationApplyError extends Error {
      constructor(readonly migration: string, readonly index: number, readonly pendingCount: number) {
        super(`migration '${migration}' failed to apply: boom`);
        this.name = "MigrationApplyError";
      }
    }
    const foreign = new ForeignMigrationApplyError("20260521012518-init", 0, 3);
    expect(foreign instanceof MigrationApplyError).toBe(false);  // guards the guard
    const msg = replayRemedy(foreign).join(" ");
    expect(msg).toContain("'20260521012518-init'");
    expect(msg).toContain("FIRST migration in the chain");
  });

  test("a same-named error WITHOUT the position fields degrades rather than lying", () => {
    const bare = new Error("something else");
    bare.name = "MigrationApplyError";
    const msg = replayRemedy(bare).join(" ");
    expect(msg).toContain("the committed chain does not apply to an empty database");
    expect(msg).not.toContain("migration 1 of");
  });

  test("every command the remedy names is runnable as typed", () => {
    // `meta migrate baseline --from-db` alone errors asking for --db, which is the same
    // "remedy you cannot execute" defect this file exists to fix, one scale smaller.
    const msg = replayRemedy(new Error("x")).join(" ");
    const baseline = msg.match(/`([^`]*baseline[^`]*)`/)?.[1] ?? "";
    expect(baseline).toContain("--from-db");
    expect(baseline).toContain("--db");
  });
});
