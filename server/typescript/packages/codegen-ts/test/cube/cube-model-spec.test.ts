// FR-044 Plan 4 — CubeRollupSpec takes one of three time forms, never two at once. The
// `@ts-expect-error` lines are checked by the package typecheck (tsconfig.typecheck.json
// includes test/), so a union that loosens fails the build, not just this file.
import { describe, test, expect } from "bun:test";
import type { CubeRollupSpec } from "../../src/cube/cube-model-spec.js";

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
