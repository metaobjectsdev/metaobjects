import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// `here` is packages/metadata, so reach the repo-root corpus with FOUR `../` levels
// (metadata → packages → typescript → server → repo root). Three lands on server/ and
// yields a non-existent server/fixtures/conformance (ENOENT under the mutation gate).
const corpus = resolve(here, "../../../../fixtures/conformance");

// The sandbox is a full copy of this package, rewritten for every mutant: keep it off the drives.
// `bun run conformance:mutation` (scripts/run-stryker.sh) picks a RAM-backed scratch directory and
// removes it afterwards; a bare `stryker run` falls back to the same place, keyed by its pid.
const sandbox =
  process.env.METAOBJECTS_STRYKER_TEMP ??
  join(process.env.DEV_SCRATCH || tmpdir(), "stryker", `metadata-${process.pid}`);

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: {
    command: `METAOBJECTS_CONFORMANCE_CORPUS=${corpus} bun test test/conformance.test.ts`,
  },
  mutate: [
    "src/parser-core.ts",
    "src/super-resolve.ts",
    "src/subtype-rules.ts",
    "src/serializer-json.ts",
    "src/overlay.ts",
    "src/provider.ts",
  ],
  // Cap parallelism. Stryker defaults to (cpuCount - 1) test-runner workers — 23
  // on the 24-thread self-hosted host — which, co-scheduled with the other heavy
  // CI lanes (java-slow, csharp, ...), starved the box into OOM. 6 leaves ~18
  // threads for the sibling jobs while keeping the mutation gate reasonably fast.
  concurrency: 6,
  tempDirName: sandbox,
  // Remove the sandbox after a failing run too, not only a passing one.
  cleanTempDir: "always",
  thresholds: { high: 60, low: 40, break: 35 },
  reporters: ["clear-text", "html"],
};
