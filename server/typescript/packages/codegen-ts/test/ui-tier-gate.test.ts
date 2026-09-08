// F75 — "does this run emit a client UI tier?" is a GENERATOR fact.
//
// `agent/ui.md` gated on `servesReadApi`, a metadata predicate that answers a different
// question ("could a UI be generated for this object?"). This file pins the aggregation
// that answers the real one, and the compatibility path for a generator copy ejected
// before the marker existed.

import { describe, test, expect } from "bun:test";
import type { Generator } from "../src/generator.js";
import { runEmitsUiTier, warnUnmarkedUiGenerators } from "../src/ui-tier-gate.js";

const gen = (name: string, extra: Partial<Generator> = {}): Generator =>
  ({ name, generate: () => [], ...extra });

describe("runEmitsUiTier", () => {
  test("an empty suite emits no UI tier — the estate that produced the finding", () => {
    expect(runEmitsUiTier([])).toBe(false);
  });

  test("a server-only suite emits no UI tier", () => {
    // entity + queries + routes + barrel: every object still serves a read API, so the
    // metadata predicate says yes and the run says no. That gap IS the finding.
    expect(runEmitsUiTier([
      gen("entity-file", { emitsEntityModule: true }),
      gen("queries-file"),
      gen("routes-file"),
      gen("barrel"),
    ])).toBe(false);
  });

  test("one marked UI generator is enough", () => {
    expect(runEmitsUiTier([gen("entity-file"), gen("form-file", { emitsUiTier: true })])).toBe(true);
  });

  test("a copy ejected before the marker existed still emits the page — matched by name", () => {
    // ADR-0034 scaffold-and-own: `meta eject` copies the template verbatim, so an adopter
    // who ejected `form-file` before this release has a copy with no marker. It emits
    // forms, so the page is TRUE for that project and must keep emitting.
    expect(runEmitsUiTier([gen("form-file")])).toBe(true);
  });
});

describe("warnUnmarkedUiGenerators", () => {
  test("says so rather than degrading silently, and names the one-line fix", () => {
    const msgs: string[] = [];
    warnUnmarkedUiGenerators([gen("entity-file"), gen("tanstack-grid")], (m) => msgs.push(m));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("'tanstack-grid'");
    expect(msgs[0]).toContain("emitsUiTier: true");
  });

  test("self-extinguishing — a marked suite is silent", () => {
    const msgs: string[] = [];
    warnUnmarkedUiGenerators([gen("form-file", { emitsUiTier: true })], (m) => msgs.push(m));
    expect(msgs).toEqual([]);
  });

  test("silent for a project with no UI generator at all — the headless case is not a defect", () => {
    const msgs: string[] = [];
    warnUnmarkedUiGenerators([gen("entity-file"), gen("queries-file")], (m) => msgs.push(m));
    expect(msgs).toEqual([]);
  });
});

// The explicit config key must win at BOTH doors. `meta docs` honoured
// `loadedConfig?.includeUiTier ?? runEmitsUiTier(...)` from the start; `runGen` computed
// the aggregation unconditionally and ignored the key — so an adopter with a renamed
// owned generator got `agent/ui.md` from `meta docs` and not from `meta gen`. An escape
// hatch honoured by one of two doors is the same defect the marker exists to close.
describe("the config key overrides the aggregation", () => {
  const uiGen = (): Generator => gen("form-file", { emitsUiTier: true });

  /** What the runner told the generators, for one config. */
  async function seenBy(
    generators: Generator[], includeUiTier?: boolean,
  ): Promise<boolean | undefined> {
    const { runGen } = await import("../src/runner.js");
    const { MetaDataLoader, InMemoryStringSource } = await import("@metaobjectsdev/metadata");
    const loaded = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify({
        "metadata.root": { package: "acme", children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "body" } }] } },
        ] },
      }), { id: "m.json", format: "json" }),
    ]);
    expect(loaded.errors).toEqual([]);
    let seen: boolean | undefined;
    const spy: Generator = {
      name: "spy",
      generate: (ctx) => { seen = ctx.config.includeUiTier; return []; },
    };
    await runGen({
      config: {
        outDir: "/tmp/ui-tier-key", extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [spy, ...generators],
        ...(includeUiTier === undefined ? {} : { includeUiTier }),
      },
      metadata: loaded.root,
      genStateDir: "/tmp/ui-tier-key-state",
    });
    return seen;
  }

  test("an explicit true wins over a suite with no UI generator", async () => {
    expect(await seenBy([], true)).toBe(true);
  });

  test("an explicit FALSE wins over a suite that HAS one — an override, not a hint", async () => {
    expect(await seenBy([uiGen()], false)).toBe(false);
  });

  test("unset falls back to the marker aggregation, in both directions", async () => {
    expect(await seenBy([])).toBe(false);
    expect(await seenBy([uiGen()])).toBe(true);
  });
});
