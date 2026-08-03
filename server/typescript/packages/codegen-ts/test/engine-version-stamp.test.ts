// #232 — the gen-state records the codegen engine version, and `meta gen` notes an
// engine change since the last run (so an unexplained regen diff is explained). The
// stamp is a separate file from `.hashes.json` and never affects the three-way merge.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEngineVersion, saveEngineVersion } from "../src/overwrite-policy.js";

let state: string;
beforeEach(() => { state = mkdtempSync(join(tmpdir(), "codegen-engine-")); });
afterEach(() => { rmSync(state, { recursive: true, force: true }); });

describe("#232 — gen-state engine-version stamp", () => {
  test("unstamped gen-state → loadEngineVersion is undefined (pre-#232 / fresh project)", () => {
    expect(loadEngineVersion(state)).toBeUndefined();
  });

  test("save then load round-trips the version, in a separate .engine.json (not .hashes.json)", () => {
    saveEngineVersion(state, "0.20.9");
    expect(loadEngineVersion(state)).toBe("0.20.9");
    expect(existsSync(join(state, ".engine.json"))).toBe(true);
    // Must NOT pollute the hashes file (the merge input).
    const engine = JSON.parse(readFileSync(join(state, ".engine.json"), "utf-8"));
    expect(engine).toEqual({ codegenVersion: "0.20.9" });
    expect(existsSync(join(state, ".hashes.json"))).toBe(false);
  });

  test("malformed .engine.json → undefined, never throws (informational only)", () => {
    // saveEngineVersion writes valid JSON; simulate corruption by overwriting.
    saveEngineVersion(state, "0.20.9");
    writeFileSync(join(state, ".engine.json"), "{ not json", "utf-8");
    expect(loadEngineVersion(state)).toBeUndefined();
  });
});
