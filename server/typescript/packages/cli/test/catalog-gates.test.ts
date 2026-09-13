// The post-selection audits `meta gen` runs over a wired suite.
//
// In the CLI rather than in codegen-ts, because both need the COMPOSED catalog: three
// of the four cases below involve `form` / `hooks` / `grid-hook`, which live in the
// react and tanstack slices that codegen-ts cannot import.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import { runGen, type Generator, type MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackQuery, tanstackGrid, tanstackGridHook } from "@metaobjectsdev/codegen-ts-tanstack";
import { composeCatalog } from "../src/lib/catalog.js";

const FIXTURE = join(import.meta.dir, "fixtures", "catalog-probe");

async function warningsFor(
  generators: Generator[],
  libraries?: string[],
): Promise<string[]> {
  const metadata = await loadMemory(FIXTURE, libraries === undefined ? {} : { libraries });
  const root = mkdtempSync(join(tmpdir(), "catalog-gates-"));
  const config: MetaobjectsGenConfig = {
    outDir: "src/generated",
    extStyle: "js",
    dialect: "sqlite",
    dbImport: "../db",
    generators,
  };
  try {
    const result = await runGen({
      config,
      metadata,
      projectRoot: root,
      dryRun: true,
      catalog: composeCatalog(),
      ...(libraries === undefined ? {} : { libraries }),
    });
    return result.warnings;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Construct a catalog generator by stable name — the same factory `--list` calls. */
function gen(name: string): Generator {
  const entry = composeCatalog()[name];
  if (entry === undefined) throw new Error(`no catalog entry "${name}"`);
  return entry.factory();
}

describe("the requires gate", () => {
  test("warns, naming what is missing and how to get it", async () => {
    const warnings = (await warningsFor([tanstackGridHook()])).join("\n");
    expect(warnings).toContain('"grid-hook" is wired');
    // grid-hook declares requires: [entity, grid, hooks] — all three unwired here.
    for (const dep of ["entity", "grid", "hooks"]) {
      expect(warnings, `names the missing "${dep}"`).toContain(`"${dep}"`);
    }
    expect(warnings).toContain("meta eject");
  });

  test("says nothing once the requirement is wired", async () => {
    const warnings = await warningsFor([
      gen("entity"), tanstackGrid(), tanstackQuery(), tanstackGridHook(),
    ]);
    expect(warnings.filter((w) => w.includes("is wired but"))).toEqual([]);
  });

  test("is silent for a generator the catalog does not know", async () => {
    // An owned or third-party generator has no declaration to check, so it must not be
    // reported as depending on nothing — the gate skips it rather than guessing.
    const mine: Generator = { name: "my-own-thing", generate: () => [] };
    const warnings = await warningsFor([mine]);
    expect(warnings.filter((w) => w.includes("is wired but"))).toEqual([]);
  });

  test("warns rather than failing — a hand-written half is legitimate", async () => {
    // The run still completes and reports files; the gate never touches the exit path.
    const metadata = await loadMemory(FIXTURE, {});
    const root = mkdtempSync(join(tmpdir(), "catalog-gates-"));
    try {
      const result = await runGen({
        config: {
          outDir: "src/generated", extStyle: "js", dialect: "sqlite", dbImport: "../db",
          generators: [tanstackGridHook()],
        },
        metadata,
        projectRoot: root,
        dryRun: true,
        catalog: composeCatalog(),
      });
      expect(result.conflicts).toEqual([]);
      expect(result.files.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the api-framework advisory", () => {
  test("warns when two api-layer generators bring different frameworks", async () => {
    const warnings = (await warningsFor([gen("entity"), gen("routes"), gen("routes-hono")])).join("\n");
    expect(warnings).toContain("two api-layer frameworks");
    expect(warnings).toContain("fastify");
    expect(warnings).toContain("hono");
    // The point of the message: nothing is broken, so say so rather than implying it.
    expect(warnings).toContain("DIFFERENT paths");
  });

  test("is silent for ONE api framework", async () => {
    const warnings = await warningsFor([gen("entity"), gen("routes")]);
    expect(warnings.filter((w) => w.includes("api-layer frameworks"))).toEqual([]);
  });

  test("does NOT fire on form + hooks + grid — client is a composition, not a conflict", async () => {
    // @metaobjectsdev/tanstack peers on react, so this is the documented, normal client
    // selection. An earlier draft's "one framework per layer" rule would have forbidden
    // the single most common one.
    const warnings = await warningsFor([
      gen("entity"), formFile(), tanstackQuery(), tanstackGrid(),
    ]);
    expect(warnings.filter((w) => w.includes("frameworks"))).toEqual([]);
  });
});

describe("the library gate (FR-043 §6)", () => {
  test("opted in, not wired: the design is in the model and its code is not generated", async () => {
    const warnings = (await warningsFor([gen("entity")], ["ai"])).join("\n");
    expect(warnings).toContain('library "ai" is opted in and implies "trace-helper"');
  });

  test("wired, not opted in: it will match nothing, and says so", async () => {
    // The failure this removes is a SILENT one: a wired generator emitting zero files
    // reads exactly like "my model has no trace entities yet".
    const warnings = (await warningsFor([gen("entity"), gen("trace-helper")], [])).join("\n");
    expect(warnings).toContain('"trace-helper" is wired');
    expect(warnings).toContain('library "ai"');
    expect(warnings).toContain("emit");
  });

  test("both halves together: silence", async () => {
    const warnings = await warningsFor([gen("entity"), gen("trace-helper")], ["ai"]);
    expect(warnings.filter((w) => w.includes("library"))).toEqual([]);
  });

  test("neither half: silence — a library nobody mentioned is not a finding", async () => {
    const warnings = await warningsFor([gen("entity")], []);
    expect(warnings.filter((w) => w.includes("library"))).toEqual([]);
  });

  test("a caller that never threads `libraries` gets no library warnings at all", async () => {
    // Undefined is "nobody told me", which is a different statement from `[]`. Claiming
    // "you opted into nothing" on a programmatic run would be a claim we cannot support.
    const warnings = await warningsFor([gen("entity"), gen("trace-helper")]);
    expect(warnings.filter((w) => w.includes("opted in"))).toEqual([]);
  });
});
