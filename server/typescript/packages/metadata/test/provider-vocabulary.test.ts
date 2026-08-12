// The canonical LOGICAL provider vocabulary, and the lints that keep it honest.
//
// Conformance fixtures name LOGICAL provider ids. Each port maps them to its own
// PHYSICAL providers — TS/C#/Python 1:1, Java one-to-many across SPI providers.
// That asymmetry is deliberate (physical packaging is idiomatic per ecosystem, and
// `expected-registry.json` is provider-blind by design, ADR-0050), but it means the
// logical vocabulary is a cross-port contract with no byte-gate of its own.
//
// `fixtures/registry-conformance/providers.json` is that contract, indexed from the
// `provider:` field in `spec/metamodel/*.json` — the actual source of truth. These
// tests assert the index agrees with the spec, and that nothing names a logical id
// that does not exist. Without them the index is just another thing to drift.
//
// Why this matters concretely: Java's conformance alias map omitted three shipped
// core providers (`index-types`, `origin-types`, `requirement-types`) and nothing
// failed, because Java's harness composes the full provider superset rather than the
// fixture's declared set. Incomplete AND unexercised is how a mapping rots.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { coreProviders } from "../src/core-types.js";

const REPO = join(import.meta.dir, "../../../../..");
const SPEC_DIR = join(REPO, "spec/metamodel");
const CANONICAL = join(REPO, "fixtures/registry-conformance/providers.json");

interface Canonical {
  providers: Record<string, { declaresTypes: boolean; projectsOnto: string[] }>;
}

const canonical = JSON.parse(readFileSync(CANONICAL, "utf8")) as Canonical;

/** Re-derive the index from the spec files, the same way the committed file was built. */
function deriveFromSpec(): Record<string, { declaresTypes: boolean; projectsOnto: Set<string> }> {
  const out: Record<string, { declaresTypes: boolean; projectsOnto: Set<string> }> = {};
  for (const f of readdirSync(SPEC_DIR).filter((n) => n.endsWith(".json")).sort()) {
    const d = JSON.parse(readFileSync(join(SPEC_DIR, f), "utf8")) as {
      provider?: string;
      types?: { type?: string; subType?: string }[];
      // subType may be a LIST (the FR-033 multi-subtype rule), expanded one per entry.
      extends?: { type?: string; subType?: string | string[] }[];
    };
    const pid = d.provider;
    if (pid === undefined) continue;
    out[pid] ??= { declaresTypes: false, projectsOnto: new Set() };
    const e = out[pid]!;
    for (const t of d.types ?? []) {
      // "*.*" is the common-attr declaration — the widest projection, not a type.
      if (t.type === "*") e.projectsOnto.add("*.*");
      else e.declaresTypes = true;
    }
    for (const x of d.extends ?? []) {
      const sts = Array.isArray(x.subType) ? x.subType : [x.subType];
      for (const st of sts) e.projectsOnto.add(`${x.type}.${st}`);
    }
  }
  return out;
}

describe("logical provider vocabulary", () => {
  const derived = deriveFromSpec();

  test("the committed index agrees with spec/metamodel/*.json", () => {
    expect(Object.keys(canonical.providers).sort()).toEqual(Object.keys(derived).sort());
    for (const [id, entry] of Object.entries(canonical.providers)) {
      expect(entry.declaresTypes).toBe(derived[id]!.declaresTypes);
      expect(entry.projectsOnto).toEqual([...derived[id]!.projectsOnto].sort());
    }
  });

  test("every composed provider is in the canonical vocabulary", () => {
    // Catches a port shipping a provider the corpus has never heard of.
    for (const p of coreProviders) expect(Object.keys(canonical.providers)).toContain(p.id);
  });

  test("exactly one provider declares types; the rest are pure projections", () => {
    // The shape ADR-0050 describes, asserted rather than assumed. If a second type
    // provider ever appears this fails loudly, which is the moment to decide whether
    // the OWN/PROJECTED split still holds.
    const declaring = Object.entries(canonical.providers).filter(([, v]) => v.declaresTypes);
    expect(declaring.map(([k]) => k)).toEqual(["metaobjects-core-types"]);
    for (const [, v] of Object.entries(canonical.providers)) {
      if (!v.declaresTypes) expect(v.projectsOnto.length).toBeGreaterThan(0);
    }
  });

  test("the fixture default set names only canonical logical ids", () => {
    // Guards against alias zombies: fixtures pinning a provider id no port registers.
    const fixtureSrc = readFileSync(
      join(REPO, "server/typescript/packages/conformance/src/fixture.ts"),
      "utf8",
    );
    const block = /const DEFAULT_PROVIDERS\s*=\s*\[([\s\S]*?)\]/.exec(fixtureSrc);
    expect(block).not.toBeNull();
    const ids = [...block![1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(Object.keys(canonical.providers)).toContain(id);
  });
});
