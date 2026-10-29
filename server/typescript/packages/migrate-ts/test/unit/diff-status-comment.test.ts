/**
 * A live comment the metadata does not declare may have been written by somebody else, and a
 * `COMMENT ON … IS NULL` cannot be undone, so clearing one is gated behind allow.dropComment.
 * Setting or changing a comment the metadata declares is not.
 */
import { describe, expect, test } from "bun:test";
import { applyStatus } from "../../src/diff/status.js";
import { BlockedChangesError } from "../../src/errors.js";
import { emit } from "../../src/emit/index.js";
import type { Change } from "../../src/types.js";

const comment = (from: string | undefined, to: string | undefined, column?: string): Change => ({
  kind: "change-comment", table: "orders", ...(column !== undefined ? { column } : {}),
  ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}),
  status: { state: "allowed" },
});

describe("change-comment status", () => {
  test("clearing an undeclared comment is blocked behind allow.dropComment", () => {
    const changes = [comment("set by a DBA", undefined, "total")];
    applyStatus(changes, {});
    expect(changes[0]!.status).toMatchObject({ state: "blocked", blockedBy: "dropComment" });
    expect(changes[0]!.status.blockedReason).toContain("--allow drop-comment");
    expect(() => emit(changes, { dialect: "postgres" })).toThrow(BlockedChangesError);
  });

  test("allow.dropComment lets the clear through, as COMMENT ON … IS NULL", () => {
    const changes = [comment("set by a DBA", undefined)];
    applyStatus(changes, { dropComment: true });
    expect(changes[0]!.status.state).toBe("allowed");
    expect(emit(changes, { dialect: "postgres" }).up).toBe(`COMMENT ON TABLE "orders" IS NULL;`);
  });

  test("setting or changing a declared comment is not gated", () => {
    const changes = [comment(undefined, "Orders"), comment("Old", "New", "total")];
    applyStatus(changes, {});
    expect(changes.map((c) => c.status.state)).toEqual(["allowed", "allowed"]);
  });
});
