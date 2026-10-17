// The run-wide orphan sweep: a full `meta gen` deletes a file it recorded writing in a
// target directory that no generator emits any more, refuses one edited since, and never
// acts on a run that did not produce the whole declared output.
//
// The rename case is the one an adopter hit: renaming a value object left the old module
// on disk, `verify --codegen` convicted it and said "run 'meta gen'", and gen never
// deleted anything, so the gate failed the same way after every run.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { runGen } from "../src/runner.js";
import { entityFile } from "../src/generators/entity-file.js";
import type { Generator } from "../src/generator.js";

const OUT = "gen";
const MANIFEST = join(".metaobjects", ".gen-state", ".hashes.json");

async function model(...names: string[]): Promise<MetaRoot> {
  const doc = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: names.map((name) => ({
        "object.value": { name, children: [{ "field.string": { name: "x" } }] },
      })),
    },
  });
  const r = await new MetaDataLoader().load([new InMemoryStringSource(doc)]);
  if (r.errors.length > 0) throw new Error(r.errors.map((e) => e.message).join("\n"));
  return r.root;
}

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "run-wide-orphans-"));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

const abs = (rel: string): string => join(projectRoot, rel);
const manifest = (): string => readFileSync(abs(MANIFEST), "utf8");

async function gen(
  names: string[],
  extra: { generators?: Generator[]; entityFilter?: string[]; generatorNames?: string[]; dryRun?: boolean } = {},
) {
  return runGen({
    config: { outDir: OUT, extStyle: "js", generators: extra.generators ?? [entityFile()] },
    metadata: await model(...names),
    projectRoot,
    ...(extra.entityFilter !== undefined && { entityFilter: extra.entityFilter }),
    ...(extra.generatorNames !== undefined && { generatorNames: extra.generatorNames }),
    ...(extra.dryRun === true && { dryRun: true }),
  });
}

describe("run-wide orphan sweep", () => {
  test("a renamed value object's old module is deleted and forgotten", async () => {
    await gen(["Telemetry"]);
    expect(existsSync(abs(`${OUT}/Telemetry.ts`))).toBe(true);

    const result = await gen(["TelemetryReading"]);
    expect(existsSync(abs(`${OUT}/TelemetryReading.ts`))).toBe(true);
    expect(existsSync(abs(`${OUT}/Telemetry.ts`))).toBe(false);
    expect(result.files).toContainEqual({ path: abs(`${OUT}/Telemetry.ts`), status: "removed" });
    expect(manifest()).not.toContain("Telemetry.ts\"");
  });

  test("a hand-edited orphan is refused by name and stays recorded", async () => {
    await gen(["Telemetry"]);
    writeFileSync(abs(`${OUT}/Telemetry.ts`), `${readFileSync(abs(`${OUT}/Telemetry.ts`), "utf8")}// mine\n`);

    const result = await gen(["TelemetryReading"]);
    expect(existsSync(abs(`${OUT}/Telemetry.ts`))).toBe(true);
    const refusal = result.warnings.find((w) => w.includes("NOT deleted"));
    expect(refusal).toContain(join(OUT, "Telemetry.ts"));
    expect(refusal).toContain("Delete each one");
    // Kept, so the refusal repeats until someone resolves it.
    expect(manifest()).toContain(join(OUT, "Telemetry.ts"));
  });

  test("a file nobody generated is never touched", async () => {
    await gen(["Telemetry"]);
    writeFileSync(abs(`${OUT}/helpers.ts`), "export const mine = 1;\n");
    await gen(["TelemetryReading"]);
    expect(existsSync(abs(`${OUT}/helpers.ts`))).toBe(true);
  });

  test("an entity-filtered run deletes nothing", async () => {
    await gen(["Telemetry", "Other"]);
    await gen(["TelemetryReading", "Other"], { entityFilter: ["Other"] });
    expect(existsSync(abs(`${OUT}/Telemetry.ts`))).toBe(true);
  });

  test("a --generators run does not sweep the other entries' output", async () => {
    const other: Generator = {
      name: "other",
      generate: () => [{ path: "other.txt", content: "x\n" }],
    };
    await gen(["Telemetry"], { generators: [entityFile(), other] });
    await gen(["Telemetry"], { generators: [entityFile(), other], generatorNames: ["other"] });
    expect(existsSync(abs(`${OUT}/Telemetry.ts`))).toBe(true);
  });

  test("--dry-run reports the deletion and performs none", async () => {
    await gen(["Telemetry"]);
    const result = await gen(["TelemetryReading"], { dryRun: true });
    expect(result.files).toContainEqual({ path: abs(`${OUT}/Telemetry.ts`), status: "removed" });
    expect(existsSync(abs(`${OUT}/Telemetry.ts`))).toBe(true);
  });
});

// `handEdits` on a generator entry: "keep" (the default) protects a hand edit, "overwrite"
// discards it, and names each discarded edit so it is never silent.
describe("handEdits", () => {
  const overwriting = (): Generator => ({ ...entityFile(), handEdits: "overwrite" });
  const edit = (rel: string): void => writeFileSync(abs(rel), `${readFileSync(abs(rel), "utf8")}// mine\n`);

  test("keep preserves an edited file (merged here, where a snapshot body exists)", async () => {
    await gen(["Telemetry"]);
    edit(`${OUT}/Telemetry.ts`);
    const result = await gen(["Telemetry", "Other"]);
    expect(readFileSync(abs(`${OUT}/Telemetry.ts`), "utf8")).toContain("// mine");
    expect(result.warnings.filter((w) => w.includes("overwrote hand-edited"))).toEqual([]);
  });

  test("overwrite replaces an edited file, re-baselines it, and says so", async () => {
    await gen(["Telemetry"], { generators: [overwriting()] });
    edit(`${OUT}/Telemetry.ts`);
    const result = await gen(["Telemetry"], { generators: [overwriting()] });
    expect(readFileSync(abs(`${OUT}/Telemetry.ts`), "utf8")).not.toContain("// mine");
    expect(result.warnings).toContainEqual(expect.stringContaining(`overwrote hand-edited ${join(OUT, "Telemetry.ts")}`));
    // Re-baselined: the next run sees an untouched file and writes nothing.
    const again = await gen(["Telemetry"], { generators: [overwriting()] });
    expect(again.warnings.filter((w) => w.includes("hand-edited"))).toEqual([]);
  });

  test("overwrite deletes an edited orphan and names it", async () => {
    await gen(["Telemetry"], { generators: [overwriting()] });
    edit(`${OUT}/Telemetry.ts`);
    const result = await gen(["TelemetryReading"], { generators: [overwriting()] });
    expect(existsSync(abs(`${OUT}/Telemetry.ts`))).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.stringContaining(`deleted hand-edited ${join(OUT, "Telemetry.ts")}, which no generator emits any more`),
    );
    expect(manifest()).not.toContain("Telemetry.ts\"");
  });

  test("overwrite never touches a file gen has no record of writing", async () => {
    await gen(["Telemetry"], { generators: [overwriting()] });
    writeFileSync(abs(`${OUT}/TelemetryReading.ts`), "export const mine = 1;\n");
    const result = await gen(["TelemetryReading"], { generators: [overwriting()] });
    expect(readFileSync(abs(`${OUT}/TelemetryReading.ts`), "utf8")).toBe("export const mine = 1;\n");
    expect(result.files).toContainEqual(expect.objectContaining({ path: abs(`${OUT}/TelemetryReading.ts`), status: "refused" }));
  });

  test("one keep generator in a directory protects its edited orphans", async () => {
    const keeper: Generator = { name: "keeper", generate: () => [{ path: "keeper.txt", content: "k\n" }] };
    await gen(["Telemetry"], { generators: [overwriting(), keeper] });
    edit(`${OUT}/Telemetry.ts`);
    const result = await gen(["TelemetryReading"], { generators: [overwriting(), keeper] });
    expect(existsSync(abs(`${OUT}/Telemetry.ts`))).toBe(true);
    expect(result.warnings.find((w) => w.includes("NOT deleted"))).toContain(join(OUT, "Telemetry.ts"));
  });
});
