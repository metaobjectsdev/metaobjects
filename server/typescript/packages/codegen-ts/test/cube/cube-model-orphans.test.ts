// FR-044 Plan 4, Task 6 — cube-model cleans up a cube file whose cube is gone.
//
// Cube compiles the whole model directory, so a stale `<Cube>.yml` left by a removed or renamed
// entity can break the compile for every cube. The generator opts in to the runner's orphan
// reconciliation for exactly its own files (the direct `.yml` children of model/cubes/ under its
// target). What this file gates, against the REAL runner and a real project directory, for both
// the built-in and the ejectable reference copy:
//
//   - a full run after an entity loses its vocabulary deletes that entity's file, and only it;
//   - a run that names entities (`meta gen <Entity>`) deletes nothing, and says why;
//   - a cube file somebody edited is refused and named, never deleted;
//   - a file the generator never wrote is never a candidate, even inside model/cubes/;
//   - --dry-run reports the removal and performs none;
//   - a project `scope` is collection config: a full run under a changed scope reconciles to it.
//
// The corpus harness (cubeModelTree) runs without a projectRoot, where the runner never
// reconciles, so none of this is visible to the golden tests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InMemoryStringSource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { defineConfig, runGen, type Generator } from "../../src/index.js";
import { cubeModel as builtinCubeModel, ownsCubeFile } from "../../src/generators/cube-model.js";
import { cubeModel as refCubeModel } from "../../src/reference/cube-model.js";

type Json = Record<string, unknown>;

const OUT_DIR = "cubes";
const PROGRAM_CUBE = join(OUT_DIR, "model", "cubes", "Program.yml");
const WEEK_CUBE = join(OUT_DIR, "model", "cubes", "Week.yml");

function entity(name: string, table: string, extra: Json[]): Json {
  return {
    "object.entity": {
      name,
      children: [
        { "source.rdb": { "@table": table } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        ...extra,
      ],
    },
  };
}

const count = (name: string, of: string): Json => ({ "measure.aggregate": { name, "@agg": "count", "@of": of } });

/** Two independent cube entities; `weekVocab: false` is "the author deleted Week's measure". */
function model(weekVocab: boolean): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme::shop",
      children: [
        entity("Program", "programs", [count("programs", "Program.id")]),
        entity("Week", "weeks", weekVocab ? [count("weeks", "Week.id")] : []),
      ],
    },
  });
}

async function load(weekVocab: boolean): Promise<MetaRoot> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(model(weekVocab))]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
  return result.root;
}

const IMPLEMENTATIONS: ReadonlyArray<{ label: string; cubeModel: () => Generator }> = [
  { label: "the built-in", cubeModel: () => builtinCubeModel() },
  { label: "the ejectable reference copy", cubeModel: () => refCubeModel() },
];

for (const impl of IMPLEMENTATIONS) {
  describe(`cube-model orphan cleanup, through runGen: ${impl.label}`, () => {
    let projectRoot: string;
    beforeEach(() => {
      projectRoot = mkdtempSync(join(tmpdir(), "cube-orphan-e2e-"));
    });
    afterEach(() => {
      rmSync(projectRoot, { recursive: true, force: true });
    });

    const abs = (rel: string): string => join(projectRoot, rel);

    interface GenOpts {
      weekVocab: boolean;
      dryRun?: boolean;
      entityFilter?: string[];
      scope?: (fqn: string) => boolean;
    }

    async function gen(opts: GenOpts) {
      return runGen({
        config: defineConfig({
          outDir: OUT_DIR,
          dialect: "postgres",
          generators: [impl.cubeModel()],
        }),
        metadata: await load(opts.weekVocab),
        projectRoot,
        ...(opts.dryRun === true && { dryRun: true }),
        ...(opts.entityFilter !== undefined && { entityFilter: opts.entityFilter }),
        ...(opts.scope !== undefined && { scope: opts.scope }),
      });
    }

    const removed = (result: Awaited<ReturnType<typeof gen>>): string[] =>
      result.files.filter((f) => f.status === "removed").map((f) => f.path);

    test("both cube files are written on the first run, and nothing is removed", async () => {
      const result = await gen({ weekVocab: true });
      expect(existsSync(abs(PROGRAM_CUBE))).toBe(true);
      expect(existsSync(abs(WEEK_CUBE))).toBe(true);
      expect(removed(result)).toEqual([]);
    });

    test("a full run after Week loses its vocabulary removes Week.yml, and only it", async () => {
      await gen({ weekVocab: true });
      const program = readFileSync(abs(PROGRAM_CUBE), "utf8");

      const result = await gen({ weekVocab: false });

      expect(existsSync(abs(WEEK_CUBE))).toBe(false);
      expect(removed(result)).toEqual([abs(WEEK_CUBE)]);
      expect(readFileSync(abs(PROGRAM_CUBE), "utf8")).toBe(program);
      // A removal is not a problem and must not masquerade as one.
      expect(result.warnings.filter((w) => w.includes("no longer produced"))).toEqual([]);
    });

    test("a run that names entities removes nothing, and says it skipped the cleanup", async () => {
      await gen({ weekVocab: true });

      // The model no longer has Week's vocabulary, but this run cannot prove that is why
      // Week.yml was not re-emitted: it was only asked about Program.
      const result = await gen({ weekVocab: false, entityFilter: ["Program"] });

      expect(existsSync(abs(WEEK_CUBE))).toBe(true);
      expect(removed(result)).toEqual([]);
      expect(result.warnings.some((w) => w.includes("Skipped orphan cleanup"))).toBe(true);
    });

    test("the same narrowed run, with Week still declaring vocabulary, removes nothing either", async () => {
      await gen({ weekVocab: true });
      const result = await gen({ weekVocab: true, entityFilter: ["Program"] });
      expect(existsSync(abs(WEEK_CUBE))).toBe(true);
      expect(removed(result)).toEqual([]);
    });

    test("a cube file somebody edited is REFUSED and named, never deleted", async () => {
      await gen({ weekVocab: true });
      const edited = `${readFileSync(abs(WEEK_CUBE), "utf8")}# kept by hand\n`;
      writeFileSync(abs(WEEK_CUBE), edited);

      const result = await gen({ weekVocab: false });

      expect(readFileSync(abs(WEEK_CUBE), "utf8")).toBe(edited);
      expect(removed(result)).toEqual([]);
      const refusal = result.warnings.find((w) => w.includes("no longer produced"));
      expect(refusal).toBeDefined();
      expect(refusal).toContain("Week.yml");
      expect(refusal).toContain("cube-model");
    });

    test("a file the generator never wrote is not a candidate, even inside model/cubes/", async () => {
      await gen({ weekVocab: true });
      const handWritten = join(OUT_DIR, "model", "cubes", "Handwritten.yml");
      const elsewhere = join(OUT_DIR, "model", "views", "Overview.yml");
      mkdirSync(dirname(abs(elsewhere)), { recursive: true });
      writeFileSync(abs(handWritten), "cubes: []\n");
      writeFileSync(abs(elsewhere), "views: []\n");

      await gen({ weekVocab: false });

      expect(existsSync(abs(handWritten))).toBe(true);
      expect(existsSync(abs(elsewhere))).toBe(true);
      expect(existsSync(abs(WEEK_CUBE))).toBe(false);
    });

    test("--dry-run reports the pending removal and performs none", async () => {
      await gen({ weekVocab: true });

      const preview = await gen({ weekVocab: false, dryRun: true });
      expect(removed(preview)).toEqual([abs(WEEK_CUBE)]);
      expect(existsSync(abs(WEEK_CUBE))).toBe(true);

      // The preview left gen-state intact, so the real run still removes it.
      const real = await gen({ weekVocab: false });
      expect(removed(real)).toEqual([abs(WEEK_CUBE)]);
      expect(existsSync(abs(WEEK_CUBE))).toBe(false);
    });

    test("every cube gone removes every cube file", async () => {
      await gen({ weekVocab: true });
      const bare = JSON.stringify({
        "metadata.root": {
          package: "acme::shop",
          children: [entity("Program", "programs", []), entity("Week", "weeks", [])],
        },
      });
      const loaded = await new MetaDataLoader().load([new InMemoryStringSource(bare)]);
      expect(loaded.errors).toEqual([]);

      await runGen({
        config: defineConfig({ outDir: OUT_DIR, dialect: "postgres", generators: [impl.cubeModel()] }),
        metadata: loaded.root,
        projectRoot,
      });

      expect(existsSync(abs(PROGRAM_CUBE))).toBe(false);
      expect(existsSync(abs(WEEK_CUBE))).toBe(false);
    });

    test("a project scope is config, not a narrowed run: a full run reconciles to it", async () => {
      // `meta gen` has no per-run scope flag; the collection's `scope` is passed on every run.
      // A scope that stops selecting Week is a changed declaration of what this project
      // generates, so Week's untouched file goes, as it does when Week's vocabulary is deleted.
      await gen({ weekVocab: true });

      const result = await gen({ weekVocab: true, scope: (fqn) => !fqn.endsWith("::Week") });

      expect(existsSync(abs(PROGRAM_CUBE))).toBe(true);
      expect(existsSync(abs(WEEK_CUBE))).toBe(false);
      expect(removed(result)).toEqual([abs(WEEK_CUBE)]);
    });
  });
}

describe("ownsCubeFile: the cleanup's blast radius", () => {
  test("claims a direct .yml child of model/cubes/, and nothing else", () => {
    expect(ownsCubeFile("model/cubes/Program.yml")).toBe(true);
    expect(ownsCubeFile("model/cubes/Match_fkHome.yml")).toBe(true);
    for (const path of [
      "model/cubes/nested/Program.yml",
      "model/cubes/Program.yaml",
      "model/cubes/Program.ts",
      "model/cubes/",
      "model/cubes",
      "model/views/Overview.yml",
      "model/Program.yml",
      "Program.yml",
      "cubes/model/cubes/Program.yml",
      "",
    ]) {
      expect({ path, owned: ownsCubeFile(path) }).toEqual({ path, owned: false });
    }
  });
});
