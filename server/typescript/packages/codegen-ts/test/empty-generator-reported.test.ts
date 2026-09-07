// A wired generator that matches nothing must say so.
//
// `namesFile()` on a model with no DB-backed object emits zero files — with no
// line, no count and no warning — and an adopter cannot tell that from a run that
// did the work. The same shape was fixed for `tanstackGrid()` in 0.21.4 with a
// self-extinguishing warning naming the metadata that enables it.
//
// It is a WARNING and never a failure, because emitting nothing is frequently the
// correct outcome: a form generator on a model with no forms has nothing to do. The
// cry-wolf objection that got the `timestampMode` warning deleted does not apply —
// this reports a fact about a generator the author deliberately wired, not a
// standing condition they cannot satisfy.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../src/index.js";
import { entityFile } from "../src/generators/entity-file.js";
import { namesFile } from "../src/generators/index.js";

/** A value object only: nothing DB-backed, so the names generator matches nothing. */
const NO_DB_MODEL = {
  "metadata.root": {
    package: "acme::shapes",
    children: [
      {
        "object.value": {
          name: "Point",
          children: [{ "field.int": { name: "x" } }, { "field.int": { name: "y" } }],
        },
      },
    ],
  },
};

/** One entity with a source — the names generator has work to do. */
const DB_MODEL = {
  "metadata.root": {
    package: "acme::shapes",
    children: [
      {
        "object.entity": {
          name: "Widget",
          children: [
            { "source.rdb": { "@table": "widgets" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
    ],
  },
};

async function warningsFor(model: unknown): Promise<string[]> {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(model), { id: "meta.json" }),
  ]);
  expect(errors.map((e) => e.message)).toEqual([]);
  const dir = mkdtempSync(join(import.meta.dir, "tmp-empty-gen-"));
  try {
    const r = await runGen({
      config: defineConfig({
        outDir: dir, extStyle: "none", dbImport: "~/db", dialect: "sqlite",
        generators: [entityFile(), namesFile()],
      }),
      metadata: root,
    });
    return r.warnings;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a wired generator that matched nothing is reported", () => {
  test("names the generator that wrote no file", async () => {
    const w = await warningsFor(NO_DB_MODEL);
    const line = w.find((m) => m.includes("matched nothing"));
    expect(line).toBeDefined();
    expect(line).toContain("names");
  });

  test("silent when every wired generator had work to do", async () => {
    // The half that keeps this from becoming noise: a normal run must not carry
    // the line at all.
    const w = await warningsFor(DB_MODEL);
    expect(w.filter((m) => m.includes("matched nothing"))).toEqual([]);
  });

  test("it is a warning, never a failure", async () => {
    const { root } = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(NO_DB_MODEL), { id: "meta.json" }),
    ]);
    const dir = mkdtempSync(join(import.meta.dir, "tmp-empty-gen-ok-"));
    try {
      // Resolving at all is the assertion: a throw here would fail the test.
      const r = await runGen({
        config: defineConfig({
          outDir: dir, extStyle: "none", dbImport: "~/db", dialect: "sqlite",
          generators: [entityFile(), namesFile()],
        }),
        metadata: root,
      });
      expect(Array.isArray(r.warnings)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
