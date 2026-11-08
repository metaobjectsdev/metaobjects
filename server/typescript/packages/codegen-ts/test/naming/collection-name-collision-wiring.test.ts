// The collision refusal follows what the run wires: the pluralized module names are checked only
// when a generator that exports them (entity modules, queries, a UI tier) is in the list, and the
// REST segments only when a routes generator is. A docs-only run (a C# adopter's docs CLI, P3's
// TS twin) emits neither, so it never refuses them.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen } from "../../src/runner.js";
import { defineConfig } from "../../src/metaobjects-config.js";
import { docsFile } from "../../src/generators/docs-file.js";
import { apiDocsFile } from "../../src/generators/api-docs-file.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { routesFile } from "../../src/generators/routes-file.js";
import { ERR_COLLECTION_NAME_COLLISION } from "../../src/naming/collection-name-collision.js";

const entity = (name: string, table: string) => ({
  "object.entity": {
    name,
    children: [
      { "source.rdb": { "@table": table } },
      { "field.long": { name: "id" } },
      { "identity.primary": { "@fields": "id", "@generation": "increment" } },
    ],
  },
});

async function run(names: [string, string], generators: Parameters<typeof defineConfig>[0]["generators"]) {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({
    "metadata.root": { package: "acme", children: [entity(names[0], "t_a"), entity(names[1], "t_b")] },
  }), { id: "m.json", format: "json" })]);
  expect(res.errors).toEqual([]);
  const tmp = mkdtempSync(join(tmpdir(), "collision-wiring-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: join(tmp, "src"), extStyle: "none", dbImport: "../db", dialect: "sqlite",
        targets: { docs: { outDir: join(tmp, "docs") } }, generators,
      }),
      metadata: res.root, projectRoot: tmp,
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

describe("the collision refusal follows the wired generators", () => {
  test("a docs-only run refuses neither a module-name nor a route collision", async () => {
    // Address / Addresses claim one pluralized name AND one REST segment ("addresses").
    await run(["Address", "Addresses"], [docsFile(), apiDocsFile()]);
  });

  test("module names are checked when the entity modules are wired", async () => {
    await expect(run(["Address", "Addresses"], [entityFile()])).rejects.toThrow(
      new RegExp(`${ERR_COLLECTION_NAME_COLLISION}.*"Addresses"`),
    );
  });

  test("routes are checked only when a routes generator is wired", async () => {
    // ApiKey / APIKey: distinct pluralized names, one REST segment.
    await run(["ApiKey", "APIKey"], [entityFile()]);
    await expect(run(["ApiKey", "APIKey"], [entityFile(), routesFile()])).rejects.toThrow(
      /REST collection segment "api_keys"/,
    );
  });
});
