/**
 * Every `--allow` hint names a token the parser accepts (adopter report D3).
 *
 * `allowFlagFor` fell back to the change's own kind when it had no mapped permission, so a
 * blocked view adoption printed `--allow replace-view`, which `parseArgs` rejects. This builds
 * a blocked change of each shape `diff` can block and checks the hint against ALLOW_TOKENS.
 *
 * A hint must also name what blocked the change NOW. A view drop sits behind up to three gates
 * (cascade, adoption, the removal itself), and a hint chosen from the change's shape repeated a
 * token the user had already passed. So each scenario is replayed the way a user would follow
 * it: grant what the hints name, diff again, until nothing is blocked.
 */
import { describe, test, expect } from "bun:test";
import {
  diff, type Change, type SchemaSnapshot, type TableDescriptor, type ViewDescriptor, type ViewReplaceProbe,
} from "@metaobjectsdev/migrate-ts";
import { ALLOW_TOKENS } from "../src/lib/args.js";
import { allowFlagFor, blockedEntriesFor, blockedHintLines, tokensToAllowOptions } from "../src/lib/allow.js";

const T = (over: Partial<TableDescriptor> = {}): TableDescriptor => ({
  name: "t",
  columns: [
    { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
    { name: "label", sqlType: { kind: "text" }, nullable: true },
  ],
  indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [], ...over,
});
const snap = (tables: TableDescriptor[], views: ViewDescriptor[] = []): SchemaSnapshot => ({ tables, views });
const view = (over: Partial<ViewDescriptor> = {}): ViewDescriptor =>
  ({ name: "v", sql: "SELECT id FROM t", fingerprint: "a".repeat(64), dependsOn: ["t"], ...over });
const unstamped: ViewDescriptor = { name: "v", sql: " SELECT t.id FROM t;" };

/** Somebody else's view built on `v`: a DROP of `v` needs CASCADE and destroys it. */
const downstream: NonNullable<ViewDescriptor["dependents"]> = [{ schema: "public", name: "downstream", relkind: "v", managed: false }];

/** `provenReplace`: the database shows the live view's columns are the expected view's, so the
 *  change is planned as a replace. Without it nothing proves the replace, and it is a drop + create. */
type Scenario = { expected: SchemaSnapshot; actual: SchemaSnapshot; provenReplace?: true };

const sameColumns: ViewReplaceProbe = async () => {
  const columns = [{ name: "id", type: "bigint", collation: "0" }];
  return { expected: columns, live: columns };
};

async function blocked({ expected, actual, provenReplace }: Scenario, granted: string[] = []): Promise<Change[]> {
  return (await diff(expected, actual, {
    dialect: "postgres",
    allow: tokensToAllowOptions(granted),
    ...(provenReplace === true ? { viewReplaceProbe: sameColumns } : {}),
  })).blocked;
}

const hints = (changes: readonly Change[]): string[] => [...new Set(changes.map(allowFlagFor))];

const SCENARIOS: Record<string, Scenario> = {
  "drop-table": { expected: snap([]), actual: snap([T()]) },
  "drop-column": { expected: snap([T({ columns: [T().columns[0]!] })]), actual: snap([T()]) },
  "lossy type change": {
    expected: snap([T({ columns: [T().columns[0]!, { name: "label", sqlType: { kind: "integer", bits: 32 }, nullable: true }] })]),
    actual: snap([T()]),
  },
  "nullable to not null": {
    expected: snap([T({ columns: [T().columns[0]!, { name: "label", sqlType: { kind: "text" }, nullable: false }] })]),
    actual: snap([T()]),
  },
  "drop-index": {
    expected: snap([T()]),
    actual: snap([T({ indexes: [{ name: "ix", columns: ["label"], unique: false }] })]),
  },
  "drop-fk": {
    expected: snap([T()]),
    actual: snap([T({ foreignKeys: [{ name: "fk", columns: ["label"], refTable: "t", refColumns: ["id"] }] })]),
  },
  "drop-check": {
    expected: snap([T()]),
    actual: snap([T({ checks: [{ name: "ck", expression: "id > 0" }] })]),
  },
  "drop-view (undeclared)": { expected: snap([T()]), actual: snap([T()], [view()]) },
  "drop-view (undeclared) with external dependents": {
    expected: snap([T()]),
    actual: snap([T()], [view({ dependents: downstream })]),
  },
  "replace-view adopting an unstamped view": {
    expected: snap([T()], [view()]), actual: snap([T()], [unstamped]), provenReplace: true,
  },
  "drop-view half of a structural adoption": {
    expected: snap([T()], [view()]),
    actual: snap([T()], [unstamped]),
  },
  "structural adoption with external dependents": {
    expected: snap([T()], [view()]),
    actual: snap([T()], [{ ...unstamped, dependents: downstream }]),
  },
};

describe("every blocked change hints at a token the parser accepts", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      const changes = await blocked(scenario);
      expect(changes.length).toBeGreaterThan(0);
      for (const c of changes) {
        expect(ALLOW_TOKENS as readonly string[]).toContain(allowFlagFor(c));
      }
    });
  }

  test("a blocked view adoption names adopt-view", async () => {
    const [c] = await blocked(SCENARIOS["replace-view adopting an unstamped view"]!);
    expect(c).toMatchObject({ kind: "replace-view" });
    const [entry] = blockedEntriesFor([c!], [c!]);
    expect(blockedHintLines(entry!).join("\n")).toContain("--allow adopt-view");
  });
});

describe("following the hints unblocks the change", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      const granted: string[] = [];
      let pending = await blocked(scenario);
      expect(pending.length).toBeGreaterThan(0);
      while (pending.length > 0) {
        const hinted = hints(pending);
        // A hint that names a token already passed leaves the user looping on it.
        for (const token of hinted) expect(granted).not.toContain(token);
        granted.push(...hinted);
        pending = await blocked(scenario, granted);
      }
    });
  }

  test("a view drop with dependents asks for the cascade, then for the drop", async () => {
    const scenario = SCENARIOS["drop-view (undeclared) with external dependents"]!;
    expect(hints(await blocked(scenario))).toEqual(["drop-view-cascade"]);
    expect(hints(await blocked(scenario, ["drop-view-cascade"]))).toEqual(["drop-view"]);
    expect(await blocked(scenario, ["drop-view-cascade", "drop-view"])).toEqual([]);
  });

  test("an adoption with dependents asks for the cascade, then for the adoption", async () => {
    const scenario = SCENARIOS["structural adoption with external dependents"]!;
    expect(hints(await blocked(scenario))).toEqual(["drop-view-cascade"]);
    expect(hints(await blocked(scenario, ["drop-view-cascade"]))).toEqual(["adopt-view"]);
    expect(await blocked(scenario, ["drop-view-cascade", "adopt-view"])).toEqual([]);
  });
});
