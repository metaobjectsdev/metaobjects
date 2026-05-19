// Fixture discovery — the single-root, multi-expectation-file corpus model.

import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_PROVIDERS = ["metaobjects-core-types"];

export interface Fixture {
  /** Scenario directory name. */
  readonly name: string;
  /** Absolute path to the scenario directory. */
  readonly dir: string;
  /** Absolute path to the input/ directory. */
  readonly inputDir: string;
  /** Provider ids to compose for this fixture (providers.json, or the core default). */
  readonly providers: readonly string[];
  readonly hasExpected: boolean;
  readonly hasExpectedEffective: boolean;
  readonly hasExpectedErrors: boolean;
  readonly hasExpectedWarnings: boolean;
  readonly hasScript: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Discover every scenario directory under a corpus root, sorted by name. */
export async function discoverFixtures(corpusRoot: string): Promise<Fixture[]> {
  const entries = (await readdir(corpusRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const fixtures: Fixture[] = [];
  for (const name of entries) {
    const dir = join(corpusRoot, name);
    const inputDir = join(dir, "input");
    if (!(await exists(inputDir))) {
      throw new Error(`Fixture '${name}' has no input/ directory`);
    }
    let providers: readonly string[] = DEFAULT_PROVIDERS;
    try {
      const raw: unknown = JSON.parse(
        await readFile(join(dir, "providers.json"), "utf8"),
      );
      if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string")) {
        throw new Error(
          `Fixture '${name}': providers.json must be a JSON array of strings`,
        );
      }
      providers = raw;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    fixtures.push({
      name, dir, inputDir, providers,
      hasExpected: await exists(join(dir, "expected.json")),
      hasExpectedEffective: await exists(join(dir, "expected-effective.json")),
      hasExpectedErrors: await exists(join(dir, "expected-errors.json")),
      hasExpectedWarnings: await exists(join(dir, "expected-warnings.json")),
      hasScript: await exists(join(dir, "script.json")),
    });
  }
  return fixtures;
}
