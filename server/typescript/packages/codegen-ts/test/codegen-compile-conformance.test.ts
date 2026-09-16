// CODEGEN-COMPILE CONFORMANCE (TypeScript lane)
//
// Generate from the SHARED cross-port corpus — fixtures/persistence-conformance/
// canonical/meta.fitness.json — and compile every emitted module with the real TS
// compiler. Zero diagnostics or the lane is red.
//
// WHY THIS EXISTS. Four defects shipped in 1.0.4 that every existing gate was blind to,
// because each one produced output that PARSES and GENERATES cleanly and only fails when
// somebody builds it:
//
//   - a view over an int-backed enum imported a codec drizzle does not export (TS);
//   - a renamed projection field selected a column that does not exist (TS);
//   - a DbContext named FK config through `nameof` on a member that is not there (C#);
//   - an extract mapper did not compile for most scalar subtypes (Java).
//
// `meta gen` exits 0 in all four cases. The metamodel, render, persistence, api-contract
// and registry corpora all stay green — they gate BEHAVIOR, and none of them asks whether
// the emitted code builds. The adopter's build is the first thing that does, which makes
// the adopter the gate. This closes that.
//
// WHY THE FITNESS CORPUS rather than a fixture of its own: it is already the shared
// cross-port model (16 entities, 2 view-backed projections, 2 value objects, two M:N
// through-junctions incl. a self-join, a 4-entity TPH hierarchy, jsonb storage, isArray,
// field.currency, field.decimal, and an AllTypes entity carrying every persistable field
// subtype incl. @intValueMap). A second kitchen sink would drift from the first, and the
// coverage this gate has is exactly the coverage the other corpora already maintain.
//
// The peer lanes are the same test in each port. If one port drops out, that port keeps
// precisely the bug class this exists to catch — so a skip here is never "just this lane".

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { loadUris, type MetaRoot, type MetaObject } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { namesFile } from "../src/generators/names-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { barrel } from "../src/generators/barrel.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";

// test → codegen-ts → packages → typescript → server → repo root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const CORPUS = resolve(
  REPO_ROOT,
  "fixtures",
  "persistence-conformance",
  "canonical",
  "meta.fitness.json",
);

async function loadCorpus(): Promise<MetaRoot> {
  const result = await loadUris([pathToFileURL(CORPUS).href]);
  if (result.errors.length > 0) {
    throw new Error(
      `${CORPUS} did not load cleanly:\n` +
        result.errors.map((e) => `  ${(e as { code?: string }).code ?? "ERROR"}: ${e.message}`).join("\n"),
    );
  }
  return result.root;
}

describe("codegen-compile conformance — the shared fitness corpus", () => {
  for (const dialect of ["postgres", "sqlite"] as const) {
    test(`${dialect}: every generated module compiles with zero diagnostics`, async () => {
      const root = await loadCorpus();
      const dir = mkdtempSync(join(import.meta.dir, `tmp-codegen-compile-${dialect}-`));
      try {
        const renderContext = makeRenderContext({
          dialect,
          loadedRoot: root,
          outDir: dir,
          dbImport: "~/db",
          pkMap: buildPkMap(root),
          relationMap: buildRelationMap(root),
        });
        // `matches` is composed from each generator's OWN filter, exactly as runner.ts
        // does it (`matches: (e) => generator.filter?.(e) ?? true`). Hardcoding
        // `() => true` here would run every generator over every object and report the
        // generator's own deliberate exclusions — a value object has no table, a TPH
        // subtype no standalone one — as if they were emit bugs. The gate has to run the
        // generators the way the runner runs them or it measures the harness.
        const genCtx = (generator: { filter?: (e: MetaObject) => boolean }): GenContext => ({
          entities: root.objects(),
          loadedRoot: root,
          matches: (e) => generator.filter?.(e) ?? true,
          projectRoot: dir,
          config: { outDir: dir, extStyle: "none", dbImport: "~/db", dialect } as never,
          renderContext,
          warn: () => {},
        });

        // The model tier plus its consumers. `allowlists: false` keeps the program over
        // drizzle + zod alone, so a diagnostic is about OUR emit and not a runtime-ts
        // resolution problem; routes are excluded for the same reason C#'s compile test
        // excludes them — the server framework's types would drown the signal.
        const generators = [
          entityFile({ allowlists: false }),
          namesFile(),
          queriesFile(),
          barrel(),
        ];
        const files = (
          await Promise.all(generators.map((g) => g.generate(genCtx(g))))
        ).flat();
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) writeFileSync(join(dir, f.path), f.content);

        const program = ts.createProgram(
          files.map((f) => join(dir, f.path)),
          {
            strict: true,
            noEmit: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            skipLibCheck: true,
          },
        );
        const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
          const where =
            d.file && d.start !== undefined
              ? `${d.file.fileName.slice(dir.length + 1)}:${
                  d.file.getLineAndCharacterOfPosition(d.start).line + 1
                } `
              : "";
          return `${where}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
        });
        expect(diagnostics).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
