// FR-023 §11.1 item 2 — end-to-end coverage for `src/reference/entity.ts`'s
// `ctx.select` call site.
//
// `src/reference/entity.ts` is not just another generator: it is the literal
// file `meta init` (ADR-0034 scaffold-and-own) copies into every scaffolded
// project's `codegen/generators/entity.ts` — the DEFAULT entity-module path
// every new project runs. Its `generate()` closure reads
// `ctx.select !== undefined ? { select: ctx.select } : undefined` when
// rendering the shared-enums module (see the file's own FR-023 comment).
// `shared-enums-imported.test.ts` already unit-tests the underlying
// `renderSharedEnumsFile({ select })` primitive directly; nothing exercised
// the WIRING — that `runGen` threads `opts.scope` through to `ctx.select`
// and that THIS file's own ternary reads it — end to end. That gap is the
// same shape as the drift this branch's final gate caught elsewhere: the
// owned copy diverging from what the built-in path actually does, silently.
//
// Two packages, one shared enum, mirroring shared-enums-imported.test.ts's
// fixture: `lib::Status` (abstract) is used ONLY by `lib::Thing`; `app::Order`
// carries no enum at all. A `scope` predicate admitting only `app::**`
// excludes `lib::Thing` — the enum's one consumer — so `enums.ts` must not be
// emitted. Without a `scope` predicate (undefined), nothing is excluded and
// `enums.ts` must carry `Status` — proving the ternary's OTHER branch too.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../src/index.js";
import { entityFile as refEntity } from "../src/reference/entity.js";

const LIB = {
  "metadata.root": {
    package: "lib",
    children: [
      { "field.enum": { name: "Status", abstract: true, "@values": ["a", "b"] } },
      {
        "object.entity": {
          name: "Thing",
          children: [
            { "source.rdb": { "@table": "things" } },
            { "field.long": { name: "id" } },
            { "field.enum": { name: "status", extends: "lib::Status" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
};

const APP = {
  "metadata.root": {
    package: "app",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "note" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
};

async function loadRoot() {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(LIB)),
    new InMemoryStringSource(JSON.stringify(APP)),
  ]);
  expect(result.errors).toEqual([]);
  return result.root;
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("src/reference/entity.ts — ctx.select call site, end to end via runGen", () => {
  test("a scope excluding the enum's only consumer suppresses enums.ts entirely", async () => {
    const root = await loadRoot();
    const dir = mkdtempSync(join(tmpdir(), "ref-entity-scope-"));
    dirs.push(dir);

    await runGen({
      config: defineConfig({
        outDir: dir,
        extStyle: "none",
        dbImport: "~/server/db",
        dialect: "sqlite",
        generators: [refEntity()],
      }),
      metadata: root,
      // Admits app::Order only — lib::Thing (the enum's one consumer) is excluded.
      scope: (fqn: string) => fqn.startsWith("app::"),
    });

    const files = readdirSync(dir);
    expect(files).toContain("Order.ts");
    expect(files).not.toContain("enums.ts");
  });

  test("with no scope declared, the same shared enum still materializes", async () => {
    const root = await loadRoot();
    const dir = mkdtempSync(join(tmpdir(), "ref-entity-noscope-"));
    dirs.push(dir);

    await runGen({
      config: defineConfig({
        outDir: dir,
        extStyle: "none",
        dbImport: "~/server/db",
        dialect: "sqlite",
        generators: [refEntity()],
      }),
      metadata: root,
      // No `scope` — byte-identical to a project with no scope declared.
    });

    const files = readdirSync(dir);
    expect(files).toContain("Order.ts");
    expect(files).toContain("enums.ts");
  });
});
