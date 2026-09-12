// FR-023 §4.3 — `codegen-ts`'s shared-model-file.ts cannot import `sdk` (the
// dependency runs the other way: `cli` depends on both), so it redefines
// `MANIFEST_FILE`, `ARTIFACT_SUFFIX` and `INTEGRITY_PREFIX` locally, guarded
// only by a "Keep in sync" comment. If they drift, a publisher's
// `sharedModelFile()` emits an artifact/manifest a consumer's `meta deps sync`
// can't match — silently, since nothing else compares the two copies. `cli`
// is the one package that depends on both `sdk` and `codegen-ts`, so it is
// where this assertion can live.
import { describe, test, expect } from "bun:test";
import { MANIFEST_FILE, ARTIFACT_SUFFIX, INTEGRITY_PREFIX } from "@metaobjectsdev/sdk";
import {
  SHARED_MODEL_MANIFEST_FILE,
  SHARED_MODEL_ARTIFACT_SUFFIX,
  SHARED_MODEL_INTEGRITY_PREFIX,
} from "@metaobjectsdev/codegen-ts/generators";

describe("shared-model-file.ts constants stay byte-equal to sdk's canonical copies", () => {
  test("MANIFEST_FILE", () => {
    expect(SHARED_MODEL_MANIFEST_FILE).toBe(MANIFEST_FILE);
  });
  test("ARTIFACT_SUFFIX", () => {
    expect(SHARED_MODEL_ARTIFACT_SUFFIX).toBe(ARTIFACT_SUFFIX);
  });
  test("INTEGRITY_PREFIX", () => {
    expect(SHARED_MODEL_INTEGRITY_PREFIX).toBe(INTEGRITY_PREFIX);
  });
});
