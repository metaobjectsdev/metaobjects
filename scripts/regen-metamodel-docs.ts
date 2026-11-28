#!/usr/bin/env bun
//
// regen-metamodel-docs.ts
//
// Regenerates the metamodel-docs corpus from the TypeScript reference, which is the source
// of the expected bytes (a port that disagrees with it is wrong, not the corpus):
//
//   fixtures/metamodel-docs/data/<page>.json   each page's template data
//   fixtures/metamodel-docs/expected/<page>    each page, rendered from templates/metamodel/
//   templates/metamodel/provider-descriptions.json
//                                              the providers' one-line descriptions, which
//                                              the ports without them on their provider
//                                              objects read beside the templates
//
// These pages describe the METAMODEL ITSELF (the type/subtype/attr vocabulary of the
// strict registry), distinct from the `docs` generator (a user's entities). Committing
// them makes a vocabulary or description change drift-gated: it must regenerate the
// corpus to stay green. Run `scripts/sync-doc-templates.sh` afterwards when a template
// or the descriptions changed, so every port's copy follows.
//
// Run:
//   bun run scripts/regen-metamodel-docs.ts

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  coreMetamodelDocsPages,
  coreProviderDescriptions,
} from "../server/typescript/packages/metadata/src/metamodel-docs/index.js";
import { frameworkTemplatesProvider } from "../server/typescript/packages/codegen-ts/src/render-engine/framework-provider.js";
import { renderDocPage } from "../server/typescript/packages/codegen-ts/src/render-engine/doc-page.js";

/** Walk up to the dir containing both spec/ and server/ — no hardcoded paths. */
function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "spec")) && existsSync(join(dir, "server"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate repo root (dir containing spec/ and server/)");
    }
    dir = parent;
  }
}

/** Write only when the bytes differ, so an unchanged corpus is not rewritten. */
function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Every file under `dir`, relative to it. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs).map((f) => join(name, f)));
    else out.push(name);
  }
  return out;
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const corpusDir = join(repoRoot, "fixtures", "metamodel-docs");
const expectedDir = join(corpusDir, "expected");
const dataDir = join(corpusDir, "data");

// The descriptions first: they are an input of the providers page.
const descriptions = Object.fromEntries(
  [...coreProviderDescriptions().entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);
writeIfChanged(
  join(repoRoot, "templates", "metamodel", "provider-descriptions.json"),
  `${JSON.stringify(descriptions, null, 2)}\n`,
);

const pages = coreMetamodelDocsPages();
const wanted = new Map<string, string>();
let bytes = 0;
for (const page of pages) {
  const content = renderDocPage(page.template, page.data, frameworkTemplatesProvider, page.path);
  wanted.set(join(expectedDir, page.path), content);
  wanted.set(join(dataDir, `${page.path}.json`), `${JSON.stringify(page.data, null, 2)}\n`);
  bytes += content.length;
}
// A removed type family drops its stale page and data.
for (const dir of [expectedDir, dataDir]) {
  for (const rel of listFiles(dir)) {
    const abs = join(dir, rel);
    if (!wanted.has(abs)) rmSync(abs);
  }
}
for (const [path, content] of wanted) writeIfChanged(path, content);

process.stdout.write(
  `Wrote ${pages.length} metamodel-docs page(s) (${bytes} bytes) and their data → ${corpusDir}\n`,
);
