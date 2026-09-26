// An adopter who ejected `entity` / `queries` BEFORE 1.0.9 and upgrades must still compile.
//
// The owned copy is the adopter's; the engine primitives it calls come from the upgraded
// package. 1.0.9-rc.4 typed `create<Entity>` as `data: <Entity>Create`, emitted by the
// package's `renderCreateFn` — but the NAME was brought into scope by the reference
// template's own import line, which a 1.0.8 owned copy does not have. An adopter estate's
// tsc then answered `Group.queries.ts(38,49): error TS2304: Cannot find name 'GroupCreate'`
// for every entity. A primitive must reach only names every owned version already imports
// (here `<Entity>InsertSchema`) or names it hoists itself.
//
// The 1.0.8 reference templates are checked in verbatim under fixtures/owned-1.0.8/ (from
// `git show v1.0.8:server/typescript/packages/codegen-ts/src/reference/{entity,queries}.ts`).
// Each mix of old/current entity and queries generators is generated and compiled with the
// real TypeScript compiler.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen, defineConfig } from "../src/index.js";
import type { Generator } from "../src/index.js";
import { entityFile as currentEntity } from "../src/reference/entity.js";
import { queriesFile as currentQueries } from "../src/reference/queries.js";
import { entityFile as ownedEntity108 } from "./fixtures/owned-1.0.8/entity.js";
import { queriesFile as ownedQueries108 } from "./fixtures/owned-1.0.8/queries.js";

const FIXTURES = ["autoset-timestamps.json", "extends-chain.json", "two-entities-fk.json", "cross-package-vo.json"];

const MIXES: Array<{ label: string; generators: () => Generator[] }> = [
  { label: "1.0.8 entity + 1.0.8 queries", generators: () => [ownedEntity108(), ownedQueries108()] },
  { label: "current entity + 1.0.8 queries", generators: () => [currentEntity(), ownedQueries108()] },
  { label: "1.0.8 entity + current queries", generators: () => [ownedEntity108(), currentQueries()] },
];

function compile(dir: string): string[] {
  const files: string[] = [];
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith(".ts")) files.push(join(f.parentPath, f.name));
  }
  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    verbatimModuleSyntax: true,
  });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where =
      d.file && d.start !== undefined
        ? `${d.file.fileName.slice(dir.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `
        : "";
    return `${where}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
}

for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`an owned pre-1.0.9 generator beside the current engine compiles (${dialect})`, () => {
    for (const fixture of FIXTURES) {
      for (const mix of MIXES) {
        test(`${fixture}: ${mix.label}`, async () => {
          const { root, errors } = await new MetaDataLoader().load([
            new FileSource(resolve(import.meta.dir, "fixtures", fixture)),
          ]);
          expect(errors).toEqual([]);
          const dir = mkdtempSync(join(import.meta.dir, `tmp-owned-skew-${dialect}-`));
          try {
            await runGen({
              config: defineConfig({ outDir: dir, extStyle: "none", dbImport: "./db", dialect, generators: mix.generators() }),
              metadata: root,
            });
            expect(compile(dir)).toEqual([]);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }, 60_000);
      }
    }
  });
}
