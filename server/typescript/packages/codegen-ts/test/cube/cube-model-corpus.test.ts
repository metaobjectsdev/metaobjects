// FR-044 Plan 4, Task 5 — the cube-model mapping corpus (fixtures/cube-model/, contract Tables B
// and K). Each case directory holds a `meta.json`, an optional `case.json` (`dialect`,
// `columnNamingStrategy`; default postgres and the product default naming strategy), and EITHER
// `expected/` (the exact tree the generator writes, byte for byte) OR `expected-error.txt` (the
// exact CubeModelError message, one trailing newline allowed). A case with neither, or both, fails,
// so a case cannot be added half-done; so does a file written but not expected, or expected but
// not written. `canonical/` is the Table H golden, checked by cube-model-canonical.test.ts.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COLUMN_NAMING_STRATEGY, type ColumnNamingStrategy } from "@metaobjectsdev/metadata";
import type { Dialect } from "../../src/index.js";
import { CubeModelError } from "../../src/cube/cube-errors.js";
import { CUBE_CORPUS_DIR, cubeModelTree, loadModelFile, readTree, type CubeRunConfig } from "../../scripts/gen-cube-model-canonical.js";

/** Directories under fixtures/cube-model/ that are not mapping cases. */
const NOT_A_CASE: ReadonlySet<string> = new Set(["canonical"]);

const DIALECTS: readonly Dialect[] = ["postgres", "mysql", "sqlite"];
const NAMING: readonly ColumnNamingStrategy[] = ["snake_case", "literal", "kebab-case"];
const CASE_KEYS: ReadonlySet<string> = new Set(["dialect", "columnNamingStrategy"]);

function caseConfig(dir: string): CubeRunConfig {
  const path = join(dir, "case.json");
  if (!existsSync(path)) return { dialect: "postgres", columnNamingStrategy: DEFAULT_COLUMN_NAMING_STRATEGY };
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path}: not a JSON object.`);
  const json = raw as Record<string, unknown>;
  for (const key of Object.keys(json)) {
    if (!CASE_KEYS.has(key)) throw new Error(`${path}: unknown key '${key}' (known: ${[...CASE_KEYS].join(", ")}).`);
  }
  const dialect = json["dialect"] ?? "postgres";
  const naming = json["columnNamingStrategy"] ?? DEFAULT_COLUMN_NAMING_STRATEGY;
  if (!DIALECTS.includes(dialect as Dialect)) throw new Error(`${path}: dialect '${String(dialect)}' is not one of ${DIALECTS.join(", ")}.`);
  if (!NAMING.includes(naming as ColumnNamingStrategy)) throw new Error(`${path}: columnNamingStrategy '${String(naming)}' is not one of ${NAMING.join(", ")}.`);
  return { dialect: dialect as Dialect, columnNamingStrategy: naming as ColumnNamingStrategy };
}

/** The CubeModelError a run threw: the runner wraps a generator's throw, keeping it as the `cause`. */
function cubeErrorOf(e: unknown): CubeModelError | undefined {
  for (let at: unknown = e; at instanceof Error; at = at.cause) {
    if (at instanceof CubeModelError) return at;
  }
  return undefined;
}

const cases = readdirSync(CUBE_CORPUS_DIR)
  .filter((name) => statSync(join(CUBE_CORPUS_DIR, name)).isDirectory() && !NOT_A_CASE.has(name))
  .sort();

describe("the cube-model mapping corpus", () => {
  test("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  test("the README lists every case, and no case it does not hold", () => {
    const readme = readFileSync(join(CUBE_CORPUS_DIR, "README.md"), "utf8");
    const listed = [...readme.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]!).filter((n) => !NOT_A_CASE.has(n));
    expect(listed.slice().sort()).toEqual(cases);
  });

  for (const name of cases) {
    test(name, async () => {
      const dir = join(CUBE_CORPUS_DIR, name);
      const expectedDir = join(dir, "expected");
      const errorFile = join(dir, "expected-error.txt");
      const hasTree = existsSync(expectedDir);
      const hasError = existsSync(errorFile);
      if (hasTree === hasError) {
        throw new Error(`${name}: a case holds exactly one of expected/ and expected-error.txt (it holds ${hasTree ? "both" : "neither"}).`);
      }
      const root = await loadModelFile(join(dir, "meta.json"));
      const config = caseConfig(dir);

      if (hasError) {
        const want = readFileSync(errorFile, "utf8").replace(/\n$/, "");
        let thrown: unknown;
        try {
          await cubeModelTree(root, config);
        } catch (e) {
          thrown = e;
        }
        if (thrown === undefined) throw new Error(`${name}: expected a CubeModelError, and the generator wrote its files.`);
        const err = cubeErrorOf(thrown);
        if (err === undefined) throw thrown;
        expect(err.message).toBe(want);
        return;
      }

      const got = await cubeModelTree(root, config);
      const want = readTree(expectedDir);
      const unexpected = [...got.keys()].filter((p) => !want.has(p));
      const missing = [...want.keys()].filter((p) => !got.has(p));
      expect({ unexpected, missing }).toEqual({ unexpected: [], missing: [] });
      for (const [path, bytes] of want) expect(`${path}\n${got.get(path)!}`).toBe(`${path}\n${bytes}`);
    });
  }
});
