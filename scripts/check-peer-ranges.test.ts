// The install-time guard (scripts/check-peer-ranges.ts, second rule): a publishable
// package cannot land dprint-node, ts-poet or a run-time @types/* in an adopter's
// tree through ANY manifest field npm installs by default. npm installs
// `optionalDependencies` by default (it skips an entry only when that install
// fails), so the guard must refuse them there exactly as it does under
// `dependencies` — otherwise a published manifest reintroduces the ~25 MB
// formatter while the gate stays green. The escape hatch stays an optional peer
// (`peerDependenciesMeta`), which npm leaves to the adopter. All three cases are
// pinned by driving `peerRangeReport` — the same walk the CLI runs — against a
// synthetic workspace.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peerRangeReport } from "./check-peer-ranges";

const created: string[] = [];
afterAll(() => { for (const d of created) rmSync(d, { recursive: true, force: true }); });

/** A throwaway workspace whose single publishable package has this manifest body. */
function workspaceWith(pkg: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "check-peer-ranges-"));
  created.push(root);
  const dir = join(root, "server/typescript/packages/fixture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@metaobjectsdev/fixture", version: "1.2.0", ...pkg }));
  return root;
}

describe("install-time guard — optionalDependencies are installed by default", () => {
  test("dprint-node under optionalDependencies is refused, naming the field", () => {
    const report = peerRangeReport(workspaceWith({ optionalDependencies: { "dprint-node": "^1.0.8" } }));
    expect(report.installOnlyDeps).toEqual([
      expect.objectContaining({ pkg: "@metaobjectsdev/fixture", dep: "dprint-node", field: "optionalDependencies" }),
    ]);
  });

  test("a run-time @types/* under optionalDependencies is refused too", () => {
    const report = peerRangeReport(workspaceWith({ optionalDependencies: { "@types/node": "^22.0.0" } }));
    expect(report.installOnlyDeps).toEqual([
      expect.objectContaining({ dep: "@types/node", field: "optionalDependencies" }),
    ]);
  });

  test("drizzle-orm and zod are refused as dependencies and as required peers", () => {
    const report = peerRangeReport(workspaceWith({
      dependencies: { zod: "^4.0.0" },
      peerDependencies: { "drizzle-orm": ">=0.38.0 <1.0.0" },
    }));
    expect(report.installOnlyDeps).toEqual([
      expect.objectContaining({ dep: "zod", field: "dependencies" }),
      expect.objectContaining({ dep: "drizzle-orm", field: "peerDependencies (required)" }),
    ]);
  });

  test("drizzle-orm and zod as optional peers pass, which is how codegen-ts declares them", () => {
    const report = peerRangeReport(workspaceWith({
      peerDependencies: { "drizzle-orm": ">=0.38.0 <1.0.0", zod: ">=3.23.0 <5.0.0" },
      peerDependenciesMeta: { "drizzle-orm": { optional: true }, zod: { optional: true } },
    }));
    expect(report.installOnlyDeps).toEqual([]);
  });

  test("a clean package passes: real dep, bounded peer counted", () => {
    const report = peerRangeReport(workspaceWith({
      dependencies: { kysely: "^0.27.0" },
      peerDependencies: { react: "^18.0.0" },
    }));
    expect(report.installOnlyDeps).toEqual([]);
    expect(report.unboundedPeers).toEqual([]);
    expect(report.peerRanges).toBe(1);
  });

  test("the documented escape hatch holds: an optional peer is not refused", () => {
    const report = peerRangeReport(workspaceWith({
      peerDependencies: { "dprint-node": "^1.0.8" },
      peerDependenciesMeta: { "dprint-node": { optional: true } },
    }));
    expect(report.installOnlyDeps).toEqual([]);
  });
});
