// Auto-discovering conformance test runner.
//
// Iterates every subdirectory of metaobjects/fixtures/conformance/ and runs
// each as a test case. Adding a new fixture directory automatically adds a
// new test — no code change required.
//
// Fixture format (see metaobjects/spec/conformance-tests.md for the full spec):
//
//   <fixture-name>/
//   ├── input/                       # one or more meta.*.json files
//   │   └── meta.*.json
//   ├── expected.json                # happy-path: canonical metamodel output
//   ├── expected-errors.json         # error case: array of error message strings
//   └── expected-warnings.json       # optional: array of warning message strings
//
// Exactly one of expected.json or expected-errors.json MUST be present.
// expected-warnings.json is optional; if absent on a happy-path fixture,
// warnings are asserted empty.

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { FileMetaDataLoader } from "../src/core/file-meta-data-loader.js";
import { canonicalSerialize } from "../src/serializer-json.js";

// ---------------------------------------------------------------------------
// Locate the conformance fixtures directory
// ---------------------------------------------------------------------------
//
// This test file lives at:
//   metaobjects/typescript/packages/metadata/test/conformance.test.ts
//
// Fixtures live at:
//   metaobjects/fixtures/conformance/
//
// So we walk up four levels from import.meta.dir to reach the repo root.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const FIXTURES_ROOT = join(REPO_ROOT, "fixtures", "conformance");

interface Fixture {
  name: string;
  dir: string;
  inputDir: string;
  expectedPath: string | undefined;
  expectedErrorsPath: string | undefined;
  expectedWarningsPath: string | undefined;
}

function discoverFixtures(): Fixture[] {
  if (!existsSync(FIXTURES_ROOT)) return [];
  return readdirSync(FIXTURES_ROOT)
    .filter((entry) => {
      const full = join(FIXTURES_ROOT, entry);
      return statSync(full).isDirectory();
    })
    .sort()
    .map((name) => {
      const dir = join(FIXTURES_ROOT, name);
      const expectedPath = join(dir, "expected.json");
      const expectedErrorsPath = join(dir, "expected-errors.json");
      const expectedWarningsPath = join(dir, "expected-warnings.json");
      return {
        name,
        dir,
        inputDir: join(dir, "input"),
        expectedPath: existsSync(expectedPath) ? expectedPath : undefined,
        expectedErrorsPath: existsSync(expectedErrorsPath) ? expectedErrorsPath : undefined,
        expectedWarningsPath: existsSync(expectedWarningsPath) ? expectedWarningsPath : undefined,
      };
    });
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function errorsToMessages(errors: Error[]): string[] {
  return errors.map((e) => e.message).sort();
}

describe("Conformance fixtures", () => {
  const fixtures = discoverFixtures();

  if (fixtures.length === 0) {
    it("at least one fixture exists", () => {
      throw new Error(
        `No fixtures found at ${FIXTURES_ROOT}. Did you forget to create the directory?`,
      );
    });
    return;
  }

  for (const fixture of fixtures) {
    it(fixture.name, async () => {
      if (!existsSync(fixture.inputDir)) {
        throw new Error(
          `Fixture "${fixture.name}" is missing required "input/" directory`,
        );
      }
      if (fixture.expectedPath === undefined && fixture.expectedErrorsPath === undefined) {
        throw new Error(
          `Fixture "${fixture.name}" has neither expected.json nor expected-errors.json`,
        );
      }
      if (fixture.expectedPath !== undefined && fixture.expectedErrorsPath !== undefined) {
        throw new Error(
          `Fixture "${fixture.name}" has BOTH expected.json and expected-errors.json — exactly one must be present`,
        );
      }

      const loader = new FileMetaDataLoader();
      const { root, errors, warnings } = await loader.loadDirectory(fixture.inputDir);

      if (fixture.expectedErrorsPath !== undefined) {
        const expectedErrors = readJsonFile(fixture.expectedErrorsPath) as string[];
        const actualErrors = errorsToMessages(errors);
        expect(actualErrors).toEqual([...expectedErrors].sort());
        return;
      }

      // At this point, expectedPath MUST be defined — the earlier validation
      // ensures exactly one of expectedPath / expectedErrorsPath is present.
      if (fixture.expectedPath === undefined) {
        throw new Error(`Fixture "${fixture.name}": unreachable — expectedPath should be defined`);
      }

      if (errors.length > 0) {
        throw new Error(
          `Fixture "${fixture.name}" expected no errors but got:\n` +
            errorsToMessages(errors).map((m) => `  - ${m}`).join("\n"),
        );
      }

      const actualSerialized = canonicalSerialize(root);
      const actualParsed = JSON.parse(actualSerialized);
      const expectedParsed = readJsonFile(fixture.expectedPath);
      expect(actualParsed).toEqual(expectedParsed);

      const actualWarnings = [...warnings].sort();
      if (fixture.expectedWarningsPath !== undefined) {
        const expectedWarnings = readJsonFile(fixture.expectedWarningsPath) as string[];
        expect(actualWarnings).toEqual([...expectedWarnings].sort());
      } else {
        if (actualWarnings.length > 0) {
          throw new Error(
            `Fixture "${fixture.name}" expected no warnings but got:\n` +
              actualWarnings.map((w) => `  - ${w}`).join("\n"),
          );
        }
      }
    });
  }
});
