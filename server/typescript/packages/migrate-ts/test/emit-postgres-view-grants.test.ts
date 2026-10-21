import { describe, expect, test } from "bun:test";
import { emit } from "../src/emit/index.js";
import type { Change, ViewDescriptor } from "../src/types.js";

const view: ViewDescriptor = { name: "v_r", sql: "SELECT 1 AS a", dependsOn: [] };
const ALLOWED = { kind: "allowed" } as unknown as Change extends { status: infer S } ? S : never;

describe("postgres: a view dropped and created again carries its grants over", () => {
  test("an unproven replace-view captures before the DROP and grants again after the CREATE", () => {
    const r = emit([{ kind: "replace-view", view, status: ALLOWED }], { dialect: "postgres" });
    const i = (needle: string): number => r.up.indexOf(needle);
    expect(i("aclexplode")).toBeGreaterThan(-1);
    expect(i("aclexplode")).toBeLessThan(i('DROP VIEW IF EXISTS "v_r"'));
    expect(i('DROP VIEW IF EXISTS "v_r"')).toBeLessThan(i('CREATE VIEW "v_r"'));
    expect(i('CREATE VIEW "v_r"')).toBeLessThan(i("GRANT %s ON %s TO %s%s"));
    expect(r.up).toContain("WITH GRANT OPTION");
    expect(r.notices).toEqual(["view public.v_r: dropped and recreated; its grants are carried over."]);
  });

  test("a drop-view paired with a create-view of the same view does the same", () => {
    const r = emit(
      [
        { kind: "drop-view", view: "v_r", status: ALLOWED },
        { kind: "create-view", view, status: ALLOWED },
      ],
      { dialect: "postgres" },
    );
    expect(r.up.indexOf("aclexplode")).toBeLessThan(r.up.indexOf('CREATE VIEW "v_r"'));
    expect(r.up).toContain("GRANT %s ON %s TO %s%s");
    expect(r.notices).toHaveLength(1);
  });

  test("a plain create, a plain drop and a proven CREATE OR REPLACE add nothing", () => {
    for (const changes of [
      [{ kind: "create-view", view, status: ALLOWED }],
      [{ kind: "drop-view", view: "v_r", status: ALLOWED }],
      [{ kind: "replace-view", view, proven: { restorable: true }, status: ALLOWED }],
    ] as Change[][]) {
      const r = emit(changes, { dialect: "postgres" });
      expect(r.up).not.toContain("aclexplode");
      expect(r.notices).toEqual([]);
    }
  });
});
