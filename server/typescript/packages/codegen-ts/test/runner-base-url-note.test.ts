// The one-shot note that tells a project its apiPrefix stopped reaching the client.
//
// WHY IT IS KEYED ON THE ENGINE STAMP AND NOT ON `apiPrefix` ALONE. `data-grid-gate.ts`
// records that a `timestampMode` warning was DELETED from `runner.ts` for firing forever
// — the cry-wolf failure. A note keyed only on `apiPrefix !== ""` would repeat it exactly:
// every project that mounts under a prefix would be nagged on every run, for ever, with
// no way to satisfy it, because whether the app passed `baseUrl` to its provider is
// runtime app code `meta gen` cannot see.
//
// Keying it on the #232 gen-state engine stamp makes it precise AND self-extinguishing:
// it fires on the first gen after upgrading past the release that removed `$apiPrefix`,
// for a project that actually had a prefix to move, and the same run records the new
// engine version so it never fires again.

import { describe, test, expect } from "bun:test";
import { shouldNoteBaseUrlMove } from "../src/runner.js";

describe("the base-URL migration note", () => {
  test("fires for a project upgrading from before the move", () => {
    expect(shouldNoteBaseUrlMove("/api", "0.24.5", "0.25.0")).toBe(true);
  });

  test("stays quiet once the project has regenerated", () => {
    expect(shouldNoteBaseUrlMove("/api", "0.25.0", "0.25.0")).toBe(false);
  });

  test("stays quiet on any later engine", () => {
    expect(shouldNoteBaseUrlMove("/api", "0.26.1", "0.25.0")).toBe(false);
  });

  test("stays quiet for a project with no prefix to move", () => {
    // `meta init` scaffolds `apiPrefix: ""`, so this is the majority of fresh projects.
    expect(shouldNoteBaseUrlMove("", "0.24.5", "0.25.0")).toBe(false);
  });

  test("stays quiet for a fresh project with no recorded engine", () => {
    // Silence is the safe default HERE, the opposite call to the 0.24.5 agent-context
    // staleness nudge: a project with no gen history has nothing to migrate, and a false
    // nag is the exact failure that got the timestampMode warning deleted.
    expect(shouldNoteBaseUrlMove("/api", undefined, "0.25.0")).toBe(false);
  });

  test("stays quiet when the recorded version is not orderable as N.N.N", () => {
    expect(shouldNoteBaseUrlMove("/api", "0.25.0-rc.1", "0.25.0")).toBe(false);
    expect(shouldNoteBaseUrlMove("/api", "unknown", "0.25.0")).toBe(false);
  });

  test("orders by component, not lexically", () => {
    // "0.9.0" > "0.25.0" as strings; as versions it is older, so the note must fire.
    expect(shouldNoteBaseUrlMove("/api", "0.9.0", "0.25.0")).toBe(true);
    // And a patch below the move still counts as before it.
    expect(shouldNoteBaseUrlMove("/api", "0.24.99", "0.25.0")).toBe(true);
  });
});
