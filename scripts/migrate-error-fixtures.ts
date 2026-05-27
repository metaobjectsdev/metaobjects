#!/usr/bin/env bun
// scripts/migrate-error-fixtures.ts
//
// FR5a fixture migration — rewrite every `error-*` fixture's
// `expected-errors.json` from the legacy `[{code}]` array shape to the
// ADR-0009 envelope:
//
//   { "errors": [ { code, source: { format, files, jsonPath } } ], "warnings": [] }
//
// Captures the actual envelope each TS ParseError emits at load time and
// writes it back. TS is the reference port: its emitted JSONPath is the
// source of truth, and the other ports' harness assertions must match it.
//
// One-shot script; not part of the build.

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MetaDataLoader } from "../server/typescript/packages/metadata/src/loader/meta-data-loader.js";
import { composeRegistry, type MetaDataTypeProvider } from "../server/typescript/packages/metadata/src/provider.js";
import { coreTypesProvider } from "../server/typescript/packages/metadata/src/core-types.js";
import { dbProvider } from "../server/typescript/packages/metadata/src/persistence/db/db-provider.js";
import { docProvider } from "../server/typescript/packages/metadata/src/core/documentation/doc-provider.js";
import { ParseError } from "../server/typescript/packages/metadata/src/errors.js";
import type { ErrorSource } from "../server/typescript/packages/metadata/src/source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const JSON_CORPUS = join(REPO_ROOT, "fixtures/conformance");
const YAML_CORPUS = join(REPO_ROOT, "fixtures/yaml-conformance");

const PROVIDERS: Record<string, MetaDataTypeProvider> = {
  [coreTypesProvider.id]: coreTypesProvider,
  [dbProvider.id]: dbProvider,
  [docProvider.id]: docProvider,
};

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/** Read existing `expected-errors.json` and return the legacy codes array. */
async function readLegacyCodes(fixtureDir: string): Promise<string[]> {
  const raw = JSON.parse(await readFile(join(fixtureDir, "expected-errors.json"), "utf8")) as unknown;
  if (Array.isArray(raw)) {
    return raw.map((e: unknown) => (e as { code: string }).code);
  }
  // Already migrated — extract codes from envelope shape.
  const obj = raw as { errors?: { code: string }[] };
  return (obj.errors ?? []).map((e) => e.code);
}

interface MigratedError {
  code: string;
  source: ErrorSource;
}

/**
 * Normalize `source.files[i]` so it's relative to the fixture's input
 * directory (not the absolute path the TS loader observed). The cross-port
 * harness convention is "file path relative to the loader's input root."
 */
function normalizeSource(src: ErrorSource, inputDir: string): ErrorSource {
  if (src.format === "json" || src.format === "yaml" || src.format === "merged" || src.format === "resolved") {
    const files = (src.files ?? []).map((f) => {
      // Files come through as absolute paths or already relative. Strip the
      // input/ prefix to leave just the basename or sub-path.
      if (f.startsWith(inputDir)) {
        return relative(inputDir, f).replace(/\\/g, "/");
      }
      return f.replace(/\\/g, "/");
    });
    if (src.format === "json") {
      return { format: "json", files: [files[0]!], jsonPath: src.jsonPath };
    }
    if (src.format === "yaml") {
      const out: ErrorSource = { format: "yaml", files: [files[0]!], jsonPath: src.jsonPath };
      if (src.yamlPosition) (out as { yamlPosition?: typeof src.yamlPosition }).yamlPosition = src.yamlPosition;
      return out;
    }
    if (src.format === "merged") {
      return { format: "merged", files, jsonPath: src.jsonPath, contributors: src.contributors };
    }
    // resolved
    const out: ErrorSource = { format: "resolved", files };
    if (src.jsonPath !== undefined) (out as { jsonPath?: string }).jsonPath = src.jsonPath;
    if (src.referrer !== undefined) (out as { referrer?: string }).referrer = src.referrer;
    if (src.target !== undefined) (out as { target?: string }).target = src.target;
    return out;
  }
  return src;
}

/**
 * Load the fixture's input directory through the TS loader and capture the
 * emitted ParseError envelopes.
 */
async function captureEnvelopes(fixtureDir: string): Promise<MigratedError[]> {
  const inputDir = join(fixtureDir, "input");
  if (!(await exists(inputDir))) {
    throw new Error(`fixture ${fixtureDir}: no input/ directory`);
  }
  const registry = composeRegistry([PROVIDERS[coreTypesProvider.id]!, PROVIDERS[dbProvider.id]!, PROVIDERS[docProvider.id]!]);
  const result = await MetaDataLoader.fromDirectory(inputDir, { registry });
  return result.errors.map((err) => {
    if (err instanceof ParseError) {
      return { code: err.code, source: normalizeSource(err.source, inputDir) };
    }
    // Non-ParseError (e.g. malformed JSON wrapped in generic Error). Try to
    // dig out a `.code` and synthesize a `{format:"json"}` source rooted at $.
    const code = (err as { code?: unknown }).code;
    return {
      code: typeof code === "string" ? code : "ERR_UNKNOWN",
      source: { format: "json", files: ["unknown"], jsonPath: "$" },
    };
  });
}

/** YAML fixtures have a flat `input.yaml` (no `input/` dir). */
async function captureYamlEnvelopes(fixtureDir: string): Promise<MigratedError[]> {
  const yamlFile = join(fixtureDir, "input.yaml");
  if (!(await exists(yamlFile))) {
    throw new Error(`yaml fixture ${fixtureDir}: no input.yaml`);
  }
  const content = await readFile(yamlFile, "utf8");
  const registry = composeRegistry([PROVIDERS[coreTypesProvider.id]!, PROVIDERS[dbProvider.id]!, PROVIDERS[docProvider.id]!]);
  const result = await MetaDataLoader.fromString(content, "yaml", { registry });
  // Preserve what TS actually emits — including the JSON-cascade format that
  // appears after YAML desugar. Document this as cross-port drift if other
  // ports thread "yaml" all the way through. The migration uses TS-emitted
  // values as the source of truth per task instructions.
  return result.errors.map((err) => {
    if (err instanceof ParseError) {
      const src = err.source;
      if (src.format === "yaml" || src.format === "json") {
        // Normalize the file token to "input.yaml" — what the consumer
        // authored, independent of TS's internal source-id naming.
        return {
          code: err.code,
          source: { format: src.format, files: ["input.yaml"], jsonPath: src.jsonPath },
        };
      }
      return { code: err.code, source: err.source };
    }
    const code = (err as { code?: unknown }).code;
    return {
      code: typeof code === "string" ? code : "ERR_UNKNOWN",
      source: { format: "yaml", files: ["input.yaml"], jsonPath: "$" },
    };
  });
}

async function migrateFixture(fixtureDir: string, kind: "json" | "yaml"): Promise<void> {
  const name = fixtureDir.split("/").pop()!;
  const legacy = await readLegacyCodes(fixtureDir);
  const captured = kind === "json" ? await captureEnvelopes(fixtureDir) : await captureYamlEnvelopes(fixtureDir);

  // Sanity: code-set must match legacy.
  const legacySorted = [...legacy].sort();
  const capturedSorted = captured.map((e) => e.code).sort();
  const codesMatch =
    legacySorted.length === capturedSorted.length &&
    legacySorted.every((c, i) => c === capturedSorted[i]);
  if (!codesMatch) {
    console.warn(
      `  ! [${name}] code-set drift: legacy=[${legacySorted.join(",")}] captured=[${capturedSorted.join(",")}]`
    );
  }

  // Emit in legacy-codes order so the canonical fixture mirrors authorial intent.
  const ordered: MigratedError[] = [];
  const pool = [...captured];
  for (const code of legacy) {
    const idx = pool.findIndex((e) => e.code === code);
    if (idx >= 0) {
      ordered.push(pool[idx]!);
      pool.splice(idx, 1);
    } else {
      ordered.push({
        code,
        source: { format: kind, files: kind === "yaml" ? ["input.yaml"] : ["unknown"], jsonPath: "$" } as ErrorSource,
      });
    }
  }
  ordered.push(...pool);

  const envelope = { errors: ordered, warnings: [] as unknown[] };
  await writeFile(
    join(fixtureDir, "expected-errors.json"),
    JSON.stringify(envelope, null, 2) + "\n",
    "utf8"
  );
  console.log(`  OK [${name}] ${ordered.map((e) => `${e.code} ${"jsonPath" in e.source ? e.source.jsonPath : "(no path)"}`).join(" | ")}`);
}

async function main(): Promise<void> {
  console.log("== fixtures/conformance (JSON) ==");
  const jsonEntries = (await readdir(JSON_CORPUS, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("error-"))
    .map((e) => join(JSON_CORPUS, e.name))
    .sort();
  for (const dir of jsonEntries) {
    try {
      await migrateFixture(dir, "json");
    } catch (err) {
      console.error(`  X ${dir}: ${(err as Error).message}`);
    }
  }

  console.log("\n== fixtures/yaml-conformance (YAML) ==");
  const yamlEntries = (await readdir(YAML_CORPUS, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("error-"))
    .map((e) => join(YAML_CORPUS, e.name))
    .sort();
  for (const dir of yamlEntries) {
    try {
      await migrateFixture(dir, "yaml");
    } catch (err) {
      console.error(`  X ${dir}: ${(err as Error).message}`);
    }
  }
}

await main();
