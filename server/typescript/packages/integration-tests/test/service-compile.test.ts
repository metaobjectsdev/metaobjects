// The service tier's compile gate (ADR-0067 layers 4 and 5): the shared fitness corpus, generated
// with the entity module, the contract types, the service and its Fastify transport, compiled with
// the real compiler in both profiles, every dialect and both output layouts.
//
// A separate gate from codegen-ts's `codegen-compile-conformance.test.ts`, which keeps its program
// to drizzle and zod: a service imports the entity module's allowlists and
// `@metaobjectsdev/runtime-ts`, and its transport imports fastify, so its program has to resolve
// all three, which this package does. Behaviour is gated by the api-contract service
// lane (`integration-tests/test/api-contract-service.test.ts`); this asks only whether what it
// runs BUILDS, which bun, running the emitted files unchecked, never asks.
import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { loadUris, type MetaRoot } from "@metaobjectsdev/metadata";
import { contractTypes, entityFile, serviceFile, serviceRoutesFile } from "@metaobjectsdev/codegen-ts/generators";
import { runGen, defineConfig, type OutputLayout } from "@metaobjectsdev/codegen-ts";
import { rmSync } from "node:fs";

setDefaultTimeout(120_000);

// Inside the package tree, so the emitted imports resolve through this package's node_modules
// (drizzle-orm, zod, fastify and the workspace's runtime-ts), as the generated api-contract lanes do.
const GEN_TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".gen-tmp");
mkdirSync(GEN_TMP, { recursive: true });

const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "fixtures", "persistence-conformance", "canonical", "meta.fitness.json");

async function loadCorpus(): Promise<MetaRoot> {
  const result = await loadUris([pathToFileURL(CORPUS).href]);
  if (result.errors.length > 0) throw new Error(`${CORPUS} did not load: ${result.errors.map((e) => e.message).join("; ")}`);
  return result.root;
}

const PROFILES: ReadonlyArray<readonly [string, ts.CompilerOptions]> = [
  ["defaults", { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true }],
  [
    "tsc --init",
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ESNext,
      types: [],
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      strict: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      noUncheckedSideEffectImports: true,
      moduleDetection: ts.ModuleDetectionKind.Force,
      skipLibCheck: true,
    },
  ],
];

function emittedTs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) {
        if (n !== ".metaobjects") walk(f);
      } else if (/\.tsx?$/.test(n)) out.push(f);
    }
  };
  walk(dir);
  return out.sort();
}

describe("service compile gate — the shared fitness corpus", () => {
  for (const layout of ["flat", "package"] as const satisfies readonly OutputLayout[]) {
    for (const dialect of ["postgres", "sqlite", "mysql"] as const) {
      for (const [profile, options] of PROFILES) {
        test(`${layout} / ${dialect} [${profile}]: the service and its transport compile with zero diagnostics`, async () => {
          const root = await loadCorpus();
          const dir = mkdtempSync(join(GEN_TMP, `service-compile-${layout}-${dialect}-`));
          try {
            await runGen({
              config: defineConfig({
                outDir: dir,
                extStyle: "js",
                dbImport: "~/db",
                dialect,
                outputLayout: layout,
                generators: [entityFile(), contractTypes(), serviceFile(), serviceRoutesFile()],
              }),
              metadata: root,
              projectRoot: dir,
            });
            const files = emittedTs(dir);
            const rel = files.map((f) => f.slice(dir.length + 1).split("\\").join("/"));
            // The tier is present by name, so the gate cannot pass on an empty service.
            expect(rel).toContain("fitness/service/index.ts");
            expect(rel).toContain("fitness/service/createProgram.ts");
            expect(rel).toContain("fitness/transport/fastify.ts");
            writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
            const program = ts.createProgram(files, { ...options, noEmit: true });
            const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
              const where =
                d.file && d.start !== undefined
                  ? `${d.file.fileName.slice(dir.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `
                  : "";
              return `${where}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
            });
            expect(diagnostics).toEqual([]);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        });
      }
    }
  }
});
