// §A6 fix round 3 (RULING R14) — `<Entity>.meta.ts`'s own `$table` field also
// references the names artifact when it is in the run, exactly like the entity
// module's descriptor (Task 1 round 1). Two things are specific to `.meta.ts` and
// get their own coverage here rather than piggybacking on the codegen-ts suite:
//
//   (b) `.meta.ts` exists SPECIFICALLY to keep Drizzle/the database out of the
//       browser bundle (see entity-meta-file.ts's header). Importing
//       `<Entity>.names.ts` must not undo that — verified by asserting the names
//       module itself carries no `import` at all (it is a plain `as const` object;
//       names-decl.ts never emits one) and that `.meta.ts` never gains a
//       drizzle-orm/zod import.
//   (c) `.meta.ts` is emitted by the UI generators, which can sit on a DIFFERENT
//       target from `namesFile()` — unlike the entity module, which always shares
//       a target with names by construction (see names-file.ts). The relative
//       sibling import has no cross-target route (round 1's
//       names-consumption.test.ts established this for the entity module); the
//       same must hold here, checked directly for `.meta.ts`.
//
// Both the built-in generators and their reference-template copies are exercised
// (reference-byte-identical.test.ts proves the two match EACH OTHER; this proves
// the PAIR does the right thing functionally, the same split client-directive.test.ts
// uses for the same reason).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig, type Generator } from "@metaobjectsdev/codegen-ts";
import { entityFile, namesFile } from "@metaobjectsdev/codegen-ts/generators";
import { tanstackQuery, tanstackGridHook } from "../src/index.js";
import { tanstackQuery as refQuery } from "../src/reference/hooks.js";
import { tanstackGridHook as refGridHook } from "../src/reference/grid-hook.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "fixtures", "multi-grid-entity.json");

type QueryFactory = typeof tanstackQuery;
type GridHookFactory = typeof tanstackGridHook;
const HALVES: Array<[string, QueryFactory, GridHookFactory]> = [
  ["built-in", tanstackQuery, tanstackGridHook],
  ["reference template", refQuery as QueryFactory, refGridHook as GridHookFactory],
];

async function loadRoot() {
  const { root, errors } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  expect(errors).toEqual([]);
  return root;
}

async function gen(
  dir: string,
  generators: Generator[],
  opts?: { targets?: Record<string, { outDir: string }>; importBase?: string },
) {
  const root = await loadRoot();
  await runGen({
    config: defineConfig({
      outDir: dir,
      extStyle: "js",
      dbImport: "../db",
      dialect: "sqlite",
      ...(opts?.targets ? { targets: opts.targets } : {}),
      ...(opts?.importBase ? { importBase: opts.importBase } : {}),
      generators,
    }),
    metadata: root,
  });
}

function readAll(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) out[f] = readFileSync(join(dir, f), "utf-8");
  return out;
}

describe.each(HALVES)("<Entity>.meta.ts references the names constant — %s", (_label, query, gridHook) => {
  test("with the names generator ACTIVE (same target), $table references the constant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-names-on-"));
    try {
      await gen(dir, [entityFile(), namesFile(), query(), gridHook()], {});
      const files = readAll(dir);
      const meta = files["Program.meta.ts"]!;

      expect(meta).toContain(`import { ProgramNames } from "./Program.names.js";`);
      expect(meta).toContain("$table: ProgramNames.sources.primary.table");
      // The literal must be GONE, not merely accompanied — the exact defect §A6 removes.
      expect(meta).not.toContain('$table: "programs"');

      // (b) bundle-safety: the names module itself is pure data (no import at
      // all), and .meta.ts gains no drizzle-orm/zod import from referencing it.
      const namesModule = files["Program.names.ts"]!;
      expect(namesModule).not.toContain("import");
      expect(meta).not.toContain("drizzle-orm");
      expect(meta).not.toContain("zod");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with the names generator ABSENT, $table keeps its literal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-names-off-"));
    try {
      await gen(dir, [entityFile(), query(), gridHook()], {});
      const meta = readAll(dir)["Program.meta.ts"]!;

      expect(meta).toContain('$table: "programs"');
      expect(meta).not.toContain("ProgramNames");
      expect(existsSync(join(dir, "Program.names.ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // (c) — the assertion that encodes why .meta.ts cannot just reuse the entity
  // module's includeNames check: it is emitted by a UI generator that can be
  // routed to a DIFFERENT target than names.
  test("an entity module and .meta.ts on a DIFFERENT target than the names generator keeps the literal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-names-xtarget-"));
    try {
      // entityFile() + namesFile() stay on the DEFAULT target; query()/gridHook()
      // (and therefore .meta.ts) route to "web". The hooks file's own cross-target
      // import of the entity module needs importBase on the default target — a
      // fact about hooks-file.ts, orthogonal to what this test checks.
      await gen(
        dir,
        [
          entityFile(),
          namesFile(),
          query({ target: "web" }),
          gridHook({ target: "web" }),
        ],
        { targets: { web: { outDir: join(dir, "web") } }, importBase: "acme-db-generated" },
      );

      const webDir = join(dir, "web");
      const meta = readFileSync(join(webDir, "Program.meta.ts"), "utf-8");
      expect(meta).toContain('$table: "programs"');
      expect(meta).not.toContain("ProgramNames");
      // The artifact really did land elsewhere — otherwise this test would pass
      // for the wrong reason (nothing emitted, nothing to import).
      expect(existsSync(join(dir, "Program.names.ts"))).toBe(true);
      expect(existsSync(join(webDir, "Program.names.ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
