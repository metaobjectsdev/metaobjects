// FR-044 Plan 4 — CubeRollupSpec takes one of three time forms, never two at once, and a
// CubeSpec reads from a table or from a SELECT, never both and never neither. The
// `@ts-expect-error` lines are checked by the package typecheck (tsconfig.typecheck.json
// includes test/), so a union that loosens fails the build, not just this file.
import { describe, test, expect } from "bun:test";
import type { CubeRollupSpec, CubeSpec } from "../../src/cube/cube-model-spec.js";

const base = { name: "R", type: "rollup", measures: ["m"], dimensions: [], segments: [] } as const;

const oneTime: CubeRollupSpec = { ...base, timeDimension: "createdAt", granularity: "month" };
const timeList: CubeRollupSpec = {
  ...base,
  timeDimensions: [
    { dimension: "recordedAt", granularity: "hour" },
    { dimension: "asOfDate", granularity: "week" },
  ],
};
const noTime: CubeRollupSpec = { ...base };

// @ts-expect-error — both time forms at once
const both: CubeRollupSpec = { ...base, timeDimension: "a", granularity: "day", timeDimensions: [] };
// @ts-expect-error — a single time dimension needs its granularity
const noGrain: CubeRollupSpec = { ...base, timeDimension: "a" };

const cubeBase = { name: "C", joins: [], dimensions: [], measures: [], segments: [], preAggregations: [] } as const;

const overTable: CubeSpec = { ...cubeBase, sqlTable: '"things"' };
const overSelect: CubeSpec = { ...cubeBase, sql: "SELECT 1" };

// @ts-expect-error — a table and a SELECT at once
const bothSources: CubeSpec = { ...cubeBase, sqlTable: '"things"', sql: "SELECT 1" };
// @ts-expect-error — neither
const noSource: CubeSpec = { ...cubeBase };

/** What a renderer does: narrow on the form. */
function timeKeys(r: CubeRollupSpec): string[] {
  if (r.timeDimension !== undefined) return [`${r.timeDimension}:${r.granularity}`];
  if (r.timeDimensions !== undefined) return r.timeDimensions.map((t) => `${t.dimension}:${t.granularity}`);
  return [];
}

describe("CubeRollupSpec", () => {
  test("each form narrows to its own fields", () => {
    expect(timeKeys(oneTime)).toEqual(["createdAt:month"]);
    expect(timeKeys(timeList)).toEqual(["recordedAt:hour", "asOfDate:week"]);
    expect(timeKeys(noTime)).toEqual([]);
    expect([both, noGrain].length).toBe(2);
  });
});

describe("CubeSpec", () => {
  test("a cube reads from a table or from a SELECT, exactly one", () => {
    expect(overTable.sqlTable).toBe('"things"');
    expect(overSelect.sql).toBe("SELECT 1");
    expect([bothSources, noSource].length).toBe(2);
  });
});
