// Runs the shared publish corpus (FR-023 §4.3) against the TypeScript reference implementation:
// a source tree plus `files` / `include` / `exclude` / `version` must produce EXACTLY the pinned
// artifact and manifest bytes, or be refused for the pinned reason. Every port's publisher runs
// the same file (fixtures/shared-model-conformance/, see its README).
//
// The manifest golden carries the token `@@METAMODEL_VERSION@@` where the manifest records the
// toolchain's `metamodelVersion`, so the goldens do not move with it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ATTR_SUBTYPE_STRING,
  composeRegistry,
  coreProviders,
  METAMODEL_VERSION,
  type MetaDataTypeProvider,
} from "@metaobjectsdev/metadata";
import { buildSharedModel, renderSharedModelFiles } from "../src/shared-model/build-shared-model.js";

const CORPUS_DIR = resolve(import.meta.dir, "../../../../../fixtures/shared-model-conformance");
const METAMODEL_VERSION_TOKEN = "@@METAMODEL_VERSION@@";

interface Refusal {
  readonly reason: "empty-selection" | "not-closed" | "non-core-vocabulary";
  readonly pairs?: readonly { referrer: string; target: string }[];
}

interface Case {
  readonly name: string;
  readonly input: {
    readonly name: string;
    readonly files: readonly string[];
    readonly include: readonly string[];
    readonly exclude?: readonly string[];
    readonly version: string;
    readonly providers?: readonly string[];
  };
  readonly expectArtifact?: string;
  readonly expectManifest?: string;
  readonly expectRefusal?: Refusal;
}

/** The corpus's one named test provider: a single common string attr no core provider ships,
 *  standing in for "vocabulary a consumer's provider adds". */
const TEST_PROVIDERS: Record<string, MetaDataTypeProvider> = {
  "secret-handling": {
    id: "test-secret-handling",
    dependencies: ["metaobjects-core-types"],
    registerTypes(registry) {
      registry.registerCommonAttrs([
        { name: "secretHandling", valueType: ATTR_SUBTYPE_STRING, required: false, description: "test-only attr." },
      ]);
    },
  },
};

const cases: Case[] = JSON.parse(readFileSync(resolve(CORPUS_DIR, "cases.json"), "utf8")).cases;

function read(rel: string): string {
  return readFileSync(resolve(CORPUS_DIR, rel), "utf8");
}

/** Which pinned refusal a thrown error is. `buildSharedModel` throws plain errors, so the
 *  reason is read off the message. */
function classify(err: Error): Refusal {
  if (/selected no nodes/.test(err.message)) return { reason: "empty-selection" };
  if (/selection is not closed/.test(err.message)) {
    const pairs = [...err.message.matchAll(/^ {2}(\S+) → (\S+)$/gm)].map((m) => ({
      referrer: m[1]!,
      target: m[2]!,
    }));
    return { reason: "not-closed", pairs };
  }
  if (/needs a provider this toolchain does not ship/.test(err.message)) return { reason: "non-core-vocabulary" };
  throw err;
}

async function publish(c: Case) {
  const providers = (c.input.providers ?? []).map((p) => TEST_PROVIDERS[p]!);
  const model = await buildSharedModel({
    name: c.input.name,
    files: c.input.files.map((f) => resolve(CORPUS_DIR, f)),
    include: c.input.include,
    ...(c.input.exclude !== undefined ? { exclude: c.input.exclude } : {}),
    ...(providers.length > 0 ? { registry: composeRegistry([...coreProviders, ...providers]) } : {}),
  });
  return renderSharedModelFiles(model, c.input.version);
}

describe("shared-model conformance — the publish corpus", () => {
  test("corpus is non-empty (a silent zero-case run is a failed gate)", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.some((c) => c.expectRefusal !== undefined)).toBe(true);
    expect(cases.some((c) => c.expectArtifact !== undefined)).toBe(true);
  });

  for (const c of cases) {
    test(c.name, async () => {
      if (c.expectRefusal !== undefined) {
        const err = await publish(c).then(
          () => undefined,
          (e: unknown) => e as Error,
        );
        if (err === undefined) throw new Error(`corpus case "${c.name}" published; it should be refused`);
        const got = classify(err);
        expect(got.reason).toBe(c.expectRefusal.reason);
        if (c.expectRefusal.pairs !== undefined) expect(got.pairs).toEqual(c.expectRefusal.pairs);
        return;
      }
      if (c.expectArtifact === undefined || c.expectManifest === undefined) {
        throw new Error(`corpus case "${c.name}" has neither expectRefusal nor expectArtifact + expectManifest`);
      }
      const { artifact, manifest } = await publish(c);
      expect(artifact.path).toBe(`${c.input.name}.metaobjects.json`);
      expect(artifact.content).toBe(read(c.expectArtifact));
      expect(manifest.path).toBe("metaobjects.pkg.json");
      expect(manifest.content).toBe(read(c.expectManifest).replaceAll(METAMODEL_VERSION_TOKEN, METAMODEL_VERSION));
    });
  }
});
