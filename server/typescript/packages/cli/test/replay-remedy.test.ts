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
