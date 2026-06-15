// FR-033 S3 — metamodel-docs byte-gate.
//
// Re-renders the metamodel docs FROM THE STRICT REGISTRY and asserts byte-
// identity against the committed expected set at
// fixtures/metamodel-docs/expected/. This makes the metamodel docs drift-gated:
// a vocabulary / description / constraint change must regenerate the docs
// (`bun run scripts/regen-metamodel-docs.ts`) to stay green. TS is the neutral
// reference (cross-port is a later deferral).

import { test, expect } from "bun:test";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { renderCoreMetamodelDocs } from "../src/metamodel-docs/index.js";

// The fixture lives at the REPO ROOT — five `../` levels up from test/
// (test → metadata → packages → typescript → server → repo-root).
const EXPECTED_DIR = join(
  import.meta.dir,
  "../../../../../fixtures/metamodel-docs/expected",
);

/** Normalize line endings so a CRLF checkout cannot fail a content-equal file. */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Recursively list expected files as paths relative to EXPECTED_DIR (sorted). */
function listExpected(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(abs).isDirectory()) {
      out.push(...listExpected(abs, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

test("rendered metamodel docs match the committed expected fixture (byte-identical)", async () => {
  const rendered = renderCoreMetamodelDocs(composeRegistry(coreProviders));

  // 1. The rendered key set equals the committed file set (no stale / missing page).
  const expectedFiles = listExpected(EXPECTED_DIR).sort();
  const renderedKeys = [...rendered.keys()].sort();
  expect(renderedKeys).toEqual(expectedFiles);

  // 2. Every rendered file is byte-identical to its committed counterpart.
  for (const rel of expectedFiles) {
    const committed = normalizeNewlines(await Bun.file(join(EXPECTED_DIR, rel)).text());
    const emitted = normalizeNewlines(rendered.get(rel)!);
    if (emitted !== committed) {
      throw new Error(
        `metamodel docs drifted for "${rel}" — regenerate with ` +
          `\`bun run scripts/regen-metamodel-docs.ts\` (a vocab/description/constraint ` +
          `change must regenerate the docs).`,
      );
    }
    expect(emitted).toBe(committed);
  }
});
