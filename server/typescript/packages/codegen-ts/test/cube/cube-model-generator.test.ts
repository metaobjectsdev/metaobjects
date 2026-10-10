// FR-044 Plan 4, Task 5 — the cube-model generator: buildCubeModel + renderCubeYaml wired into
// `meta gen`. One file per cube at model/cubes/<Cube>.yml under the target's outDir. The build's
// universe is the generator's own `filter` (fixed config), so a cube's bytes never depend on the
// run; the run's selection (`meta gen <Entity>`, `scope`) decides only which files are written:
// each selected entity's cube and every cube it reaches through joins, transitively, because a
// selected cube's `@via` adds members to the cubes it reaches. Every model is loaded with the real
// loader and run through runGen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { InMemoryStringSource, MetaDataLoader, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { defineConfig, runGen, type MetaobjectsGenConfig } from "../../src/index.js";
import { buildCubeModel } from "../../src/cube/build-cube-model.js";
import { CubeModelError, ERR_CUBE_UNSUPPORTED_DIALECT } from "../../src/cube/cube-errors.js";
import { renderCubeYaml } from "../../src/cube/cube-yaml.js";
import { cubeModel } from "../../src/generators/cube-model.js";

type Json = Record<string, unknown>;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cube-model-gen-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function entity(name: string, children: Json[], extra: Json = {}): Json {
  return { "object.entity": { name, ...extra, children } };
}

const longId: Json = { "field.long": { name: "id" } };
const pk: Json = { "identity.primary": { name: "id", "@fields": "id" } };

function program(extra: Json[] = []): Json {
  return entity("Program", [
    { "source.rdb": { "@table": "programs" } },
    longId,
    { "field.string": { name: "title" } },
    pk,
    ...extra,
  ]);
}

function week(extra: Json[] = []): Json {
  return entity("Week", [
    { "source.rdb": { "@table": "weeks" } },
    longId,
    { "field.long": { name: "programId" } },
    pk,
    { "identity.reference": { name: "fkProgram", "@fields": "programId", "@references": "Program" } },
    ...extra,
  ]);
}

const programsCount: Json = { "measure.aggregate": { name: "programs", "@agg": "count", "@of": "Program.id" } };
const weeksCount: Json = { "measure.aggregate": { name: "weeks", "@agg": "count", "@of": "Week.id" } };
const programTitle: Json = {
  "dimension.attribute": { name: "programTitle", "@of": "Program.title", "@via": "Week.fkProgram" },
};

/** Program declares a measure; Week reads Program.title through its reference. */
const PROGRAM_AND_WEEK = [program([programsCount]), week([weeksCount, programTitle])];

async function load(...roots: { pkg: string; children: Json[] }[]): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load(
    roots.map((r) => new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: r.pkg, children: r.children } }))),
  );
  expect(errors.map((e) => e.message)).toEqual([]);
  return root;
}

const loadOne = (children: Json[]): Promise<MetaRoot> => load({ pkg: "acme::shop", children });

/** Every file under `dir`, keyed by its `/`-separated path relative to `dir`. */
function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(dir, full).split("\\").join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return out;
}

async function gen(
  root: MetaRoot,
  over: Partial<MetaobjectsGenConfig> & { generators: MetaobjectsGenConfig["generators"] },
  extra: { entityFilter?: string[]; scope?: (fqn: string) => boolean } = {},
): Promise<Map<string, string>> {
  // Each run writes into a fresh directory with its own gen-state, so runs never merge.
  const run = mkdtempSync(join(tmp, "run-"));
  await runGen({
    config: defineConfig({ dialect: "postgres", ...over, outDir: join(run, "out") }),
    metadata: root,
    genStateDir: join(run, ".gen-state"),
    ...extra,
  });
  return readTree(join(run, "out"));
}

/** The CubeModelError a run threw: the runner wraps it, keeping it as the `cause`. */
async function genError(root: MetaRoot, over: Partial<MetaobjectsGenConfig> & { generators: MetaobjectsGenConfig["generators"] }): Promise<CubeModelError> {
  try {
    await gen(root, over);
  } catch (e) {
    for (let at: unknown = e; at instanceof Error; at = at.cause) {
      if (at instanceof CubeModelError) return at;
    }
    throw e;
  }
  throw new Error("expected a CubeModelError");
}

describe("the generator", () => {
  test("is named cube-model, with no filter and no target unless given", () => {
    const g = cubeModel();
    expect(g.name).toBe("cube-model");
    expect(g.filter).toBeUndefined();
    expect(g.target).toBeUndefined();
    const only = (o: MetaObject): boolean => o.name === "Week";
    const narrowed = cubeModel({ filter: only, target: "cube" });
    expect(narrowed.filter).toBe(only);
    expect(narrowed.target).toBe("cube");
  });

  test("writes model/cubes/<Cube>.yml per cube, each the renderer's bytes for the whole-model build", async () => {
    const root = await loadOne(PROGRAM_AND_WEEK);
    const files = await gen(root, { generators: [cubeModel()] });
    const model = buildCubeModel(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect([...files.keys()]).toEqual(["model/cubes/Program.yml", "model/cubes/Week.yml"]);
    for (const cube of model.cubes) expect(files.get(`model/cubes/${cube.name}.yml`)).toBe(renderCubeYaml(cube));
  });

  test("a model with no dimension, measure or segment gets no file", async () => {
    const root = await loadOne([program(), week()]);
    expect(await gen(root, { generators: [cubeModel()] })).toEqual(new Map());
  });

  test("the target option writes the files under that target's outDir", async () => {
    const root = await loadOne(PROGRAM_AND_WEEK);
    const run = mkdtempSync(join(tmp, "target-"));
    await runGen({
      config: defineConfig({
        outDir: join(run, "default"),
        dialect: "postgres",
        targets: { cube: { outDir: join(run, "cube") } },
        generators: [cubeModel({ target: "cube" })],
      }),
      metadata: root,
      genStateDir: join(run, ".gen-state"),
    });
    expect([...readTree(join(run, "cube")).keys()]).toEqual(["model/cubes/Program.yml", "model/cubes/Week.yml"]);
    expect(readTree(join(run, "default"))).toEqual(new Map());
  });
});

describe("dialect and naming come from the config", () => {
  test("the dialect defaults to the config's: mysql quotes with backticks", async () => {
    const root = await loadOne([program([programsCount])]);
    const files = await gen(root, { dialect: "mysql", generators: [cubeModel()] });
    expect(files.get("model/cubes/Program.yml")).toContain("sql_table: '`programs`'");
  });

  test("the dialect option overrides the config's", async () => {
    const root = await loadOne([program([programsCount])]);
    const files = await gen(root, { dialect: "postgres", generators: [cubeModel({ dialect: "mysql" })] });
    expect(files.get("model/cubes/Program.yml")).toContain("sql_table: '`programs`'");
  });

  test("the column naming strategy is the config's (snake_case by default)", async () => {
    const root = await loadOne([program(), week([weeksCount, { "dimension.attribute": { name: "program", "@of": "Week.programId" } }])]);
    const snake = await gen(root, { generators: [cubeModel()] });
    expect(snake.get("model/cubes/Week.yml")).toContain(`sql: '{CUBE}."program_id"'`);
    const literal = await gen(root, { columnNamingStrategy: "literal", generators: [cubeModel()] });
    expect(literal.get("model/cubes/Week.yml")).toContain(`sql: '{CUBE}."programId"'`);
  });
});

describe("ERR_CUBE_UNSUPPORTED_DIALECT — only when the run would write a cube", () => {
  test("a sqlite config with reporting vocabulary is refused, saying how to pass the dialect", async () => {
    const root = await loadOne([program([programsCount])]);
    const err = await genError(root, { dialect: "sqlite", generators: [cubeModel()] });
    expect(err.code).toBe(ERR_CUBE_UNSUPPORTED_DIALECT);
    expect(err.message).toContain("'sqlite'");
    expect(err.message).toContain("Cube lists Postgres and MySQL among its data sources");
    expect(err.message).toContain(`cubeModel({ dialect: "postgres" })`);
    expect(err.message).toContain("'acme::shop::Program'");
  });

  test("a sqlite config with no reporting vocabulary writes nothing and raises nothing", async () => {
    const root = await loadOne([program(), week()]);
    expect(await gen(root, { dialect: "sqlite", generators: [cubeModel()] })).toEqual(new Map());
  });

  test("a sqlite config whose selection matches no cube entity writes nothing and raises nothing", async () => {
    const root = await loadOne(PROGRAM_AND_WEEK);
    const filter = (o: MetaObject): boolean => o.name === "Nobody";
    expect(await gen(root, { dialect: "sqlite", generators: [cubeModel({ filter })] })).toEqual(new Map());
  });

  test("a sqlite config with a dialect option of postgres writes the cubes", async () => {
    const root = await loadOne([program([programsCount])]);
    const files = await gen(root, { dialect: "sqlite", generators: [cubeModel({ dialect: "postgres" })] });
    expect([...files.keys()]).toEqual(["model/cubes/Program.yml"]);
  });
});

describe("selection — the run decides which files, never their bytes", () => {
  test("meta gen <Entity>: a byte-identical subset of the full run, with every cube the entity's cube reaches", async () => {
    const root = await loadOne(PROGRAM_AND_WEEK);
    const full = await gen(root, { generators: [cubeModel()] });
    // Week reaches Program, and its @via adds Program's `title` member: Program.yml is written too.
    const onlyWeek = await gen(root, { generators: [cubeModel()] }, { entityFilter: ["Week"] });
    expect([...onlyWeek.keys()]).toEqual(["model/cubes/Program.yml", "model/cubes/Week.yml"]);
    for (const [path, bytes] of onlyWeek) expect(bytes).toBe(full.get(path)!);
    // Program alone still carries the member Week reads: its bytes do not depend on the run.
    const onlyProgram = await gen(root, { generators: [cubeModel()] }, { entityFilter: ["Program"] });
    expect([...onlyProgram.keys()]).toEqual(["model/cubes/Program.yml"]);
    expect(onlyProgram.get("model/cubes/Program.yml")).toBe(full.get("model/cubes/Program.yml")!);
    expect(onlyProgram.get("model/cubes/Program.yml")).toContain("- name: title");
  });

  test("scope: a byte-identical subset of the full run", async () => {
    const root = await load(
      { pkg: "acme::shop", children: PROGRAM_AND_WEEK },
      { pkg: "acme::ops", children: [entity("Ticket", [{ "source.rdb": { "@table": "tickets" } }, longId, pk, { "measure.aggregate": { name: "tickets", "@agg": "count", "@of": "Ticket.id" } }])] },
    );
    const full = await gen(root, { generators: [cubeModel()] });
    expect([...full.keys()]).toEqual(["model/cubes/Program.yml", "model/cubes/Ticket.yml", "model/cubes/Week.yml"]);
    const ops = await gen(root, { generators: [cubeModel()] }, { scope: (fqn) => fqn.startsWith("acme::ops::") });
    expect([...ops.keys()]).toEqual(["model/cubes/Ticket.yml"]);
    expect(ops.get("model/cubes/Ticket.yml")).toBe(full.get("model/cubes/Ticket.yml")!);
  });

  test("a join-target cube is written with the cube that reaches it", async () => {
    // Program declares nothing: it is only a join target of Week's @via.
    const root = await loadOne([program(), week([weeksCount, programTitle])]);
    const onlyWeek = await gen(root, { generators: [cubeModel()] }, { entityFilter: ["Week"] });
    expect([...onlyWeek.keys()]).toEqual(["model/cubes/Program.yml", "model/cubes/Week.yml"]);
    expect(onlyWeek.get("model/cubes/Program.yml")).toContain("public: false");
    // Selecting the join target alone writes nothing: it is a cube only because Week reaches it.
    expect(await gen(root, { generators: [cubeModel()] }, { entityFilter: ["Program"] })).toEqual(new Map());
  });

  test("a selection of only a report writes nothing (its rollup rides with its @from cube)", async () => {
    const report: Json = {
      "object.report": {
        name: "WeekTotals",
        "@from": "Week",
        "@measures": ["weeks"],
        children: [{ "source.rdb": { "@kind": "view", "@view": "v_week_totals" } }],
      },
    };
    const root = await loadOne([...PROGRAM_AND_WEEK, report]);
    const full = await gen(root, { generators: [cubeModel()] });
    expect(full.get("model/cubes/Week.yml")).toContain("- name: WeekTotals");
    expect(await gen(root, { generators: [cubeModel()] }, { entityFilter: ["WeekTotals"] })).toEqual(new Map());
  });
});

describe("the filter option is the build's universe", () => {
  test("an entity it excludes, and no @via reaches, has no cube, and adds nothing to the cubes it would reach", async () => {
    // An excluded entity that another cube's @via reaches is still written, as a join-target
    // cube (build-cube-model.test.ts, Table A).
    const root = await loadOne(PROGRAM_AND_WEEK);
    const files = await gen(root, { generators: [cubeModel({ filter: (o) => o.name === "Program" })] });
    expect([...files.keys()]).toEqual(["model/cubes/Program.yml"]);
    expect(files.get("model/cubes/Program.yml")).not.toContain("- name: title");
  });

  test("it steps around a refusal on an entity it excludes", async () => {
    const tags: Json = entity("Tagged", [
      { "source.rdb": { "@table": "tagged" } },
      longId,
      pk,
      { "field.string": { name: "tags", isArray: true } },
      { "dimension.attribute": { name: "tag", "@of": "Tagged.tags" } },
    ]);
    const root = await loadOne([program([programsCount]), tags]);
    await expect(gen(root, { generators: [cubeModel()] })).rejects.toThrow("ERR_CUBE_UNMAPPABLE_DIMENSION");
    const files = await gen(root, { generators: [cubeModel({ filter: (o) => o.name !== "Tagged" })] });
    expect([...files.keys()]).toEqual(["model/cubes/Program.yml"]);
  });

  test("it settles a cube name collision, as ERR_CUBE_NAME_COLLISION advises", async () => {
    const counted = (pkg: string): { pkg: string; children: Json[] } => ({
      pkg,
      children: [entity("Order", [{ "source.rdb": { "@table": `${pkg.replace("::", "_")}_orders` } }, longId, pk, { "measure.aggregate": { name: "orders", "@agg": "count", "@of": "Order.id" } }])],
    });
    const root = await load(counted("acme::a"), counted("acme::b"));
    // The runner refuses two same-named entities in one run (ERR_COLLECTION_NAME_COLLISION), so
    // the run is scoped to one package. Scope narrows what is written, not the build: acme::b's
    // Order is still in the Cube model, and still collides.
    const inA = (fqn: string): boolean => fqn.startsWith("acme::a::");
    await expect(gen(root, { generators: [cubeModel()] }, { scope: inA })).rejects.toThrow("ERR_CUBE_NAME_COLLISION");
    const onlyA = (o: MetaObject): boolean => o.resolutionKey() === "acme::a::Order";
    const files = await gen(root, { generators: [cubeModel({ filter: onlyA })] }, { scope: inA });
    expect([...files.keys()]).toEqual(["model/cubes/Order.yml"]);
    expect(files.get("model/cubes/Order.yml")).toContain(`sql_table: '"acme_a_orders"'`);
  });
});
