// `@emitRoutes` / `@emitTanstack` / `@emitForm` / `@emitGrid` / `@emitAngular` were read
// off metadata by generator filters and were NEVER registered metamodel vocabulary. The
// strict loader — which `meta verify` runs — rejects every one with ERR_UNKNOWN_ATTR,
// while `meta gen` loads non-strict and honoured them. So an adopter who authored the
// documented per-entity opt-out got working suppression AND a red `meta verify`.
//
// The reads are gone. The hazard that creates is a SILENT behaviour change: a project
// sitting on a working `@emitRoutes: false` today would see its suppressed file reappear
// with nothing said. So `meta gen` says it, following the `layout.dataGrid` (#287) and
// prompt-generator precedents — warning only, self-extinguishing, and fired from the
// RUNNER so it lands once per run whether or not the generator it used to suppress is
// even wired.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource, retiredAttr, type MetaRoot } from "@metaobjectsdev/metadata";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { RETIRED_CODEGEN_ATTRS } from "../src/constants.js";
import { warnRetiredCodegenAttrs } from "../src/retired-codegen-attrs.js";
import { entityFile } from "../src/generators/entity-file.js";
import { routesFile } from "../src/generators/routes-file.js";

/** An entity carrying `attrs` verbatim, source-backed so it reaches every generator. */
function entity(name: string, attrs: Record<string, unknown> = {}): unknown {
  return {
    "object.entity": {
      name,
      ...attrs,
      children: [
        { "source.rdb": { "@table": name.toLowerCase() } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "label", "@maxLength": 50 } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ],
    },
  };
}

async function loadRoot(...children: unknown[]): Promise<MetaRoot> {
  // The NON-strict loader, which is what `meta gen` uses — and the reason these
  // attributes worked under `gen` while failing `verify`. A strict load of this same
  // document is ERR_UNKNOWN_ATTR, which is the defect, not a quirk of this test.
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "demo", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

/** Collect the warnings a real `runGen` produces, generating into a throwaway dir. */
async function warningsFrom(root: MetaRoot, generators = [entityFile()]): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "retired-attrs-"));
  try {
    const res = await runGen({
      config: defineConfig({
        outDir: dir, extStyle: "none", dbImport: "../db", dialect: "sqlite", generators,
      }),
      metadata: root,
    });
    return res.warnings;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("retired @emit* codegen attributes — the `meta gen` warning", () => {
  test("every retired name carries a replacement that names a real API", () => {
    // The list and the warning text share ONE record precisely so they cannot drift.
    // Assert the shape rather than the prose: a name with an empty replacement would
    // produce a warning that diagnoses without directing.
    expect(RETIRED_CODEGEN_ATTRS.map((a) => a.name).sort()).toEqual(
      ["emitAngular", "emitForm", "emitGrid", "emitRoutes", "emitTanstack"],
    );
    for (const { name, replacement } of RETIRED_CODEGEN_ATTRS) {
      expect(name.startsWith("@")).toBe(false);        // bare name; the `@` is added by the message
      expect(replacement.length).toBeGreaterThan(20);
      expect(replacement).toMatch(/\(|`/);             // names a call or a config key
    }
  });

  // The same five names are now stated TWICE: here, paired with generator-specific advice
  // for the `meta gen` warning, and in the metadata package's RETIRED_VOCABULARY, which the
  // strict loader's diagnostic and `meta upgrade --apply` both read. Neither list can be
  // derived from the other — the replacement text is codegen knowledge, and the rewrite is
  // loader knowledge — so the two are pinned to agree instead. Without this, dropping a
  // name from one side leaves either a `meta gen` warning for an attribute `meta upgrade`
  // refuses to touch, or an upgrade that silently deletes an attribute the generators still
  // honour. That is the same one-rule-two-doors shape the rest of this release is about.
  test("agrees with the metadata package's retirement map, name for name", () => {
    for (const { name } of RETIRED_CODEGEN_ATTRS) {
      const note = retiredAttr("object.entity", name);
      expect(note, `@${name} warns at gen time but is not retired vocabulary`).toBeDefined();
      // And `meta upgrade` must be able to make the edit the warning tells them to make.
      expect(note?.automated, `@${name} is retired but not mechanically removable`).toBe(true);
    }
  });

  test("SILENT when no retired attribute is present", async () => {
    // The self-extinguishing half. A gate that fires on a clean model teaches the reader
    // to skim, which is how the original doc line got missed in the first place.
    const warnings = await warningsFrom(await loadRoot(entity("Customer")));
    for (const { name } of RETIRED_CODEGEN_ATTRS) {
      expect(warnings.join("\n")).not.toContain(`@${name}`);
    }
  });

  test("fires once per retired attribute, naming every object that carries it", async () => {
    const root = await loadRoot(
      entity("Subscriber", { "@emitRoutes": false }),
      entity("Invoice", { "@emitRoutes": false }),
      entity("Audit", { "@emitTanstack": false }),
      entity("Clean"),
    );
    const warnings = await warningsFrom(root);

    const routesWarnings = warnings.filter((w) => w.includes("@emitRoutes"));
    expect(routesWarnings.length).toBe(1);                 // ONE per attribute, not per object
    expect(routesWarnings[0]!).toContain("Subscriber");
    expect(routesWarnings[0]!).toContain("Invoice");
    expect(routesWarnings[0]!).not.toContain("Clean");
    expect(routesWarnings[0]!).toContain("ERR_UNKNOWN_ATTR"); // says WHY, not just what
    expect(routesWarnings[0]!).toContain("routesFile(");      // says what to do instead

    expect(warnings.filter((w) => w.includes("@emitTanstack")).length).toBe(1);
    expect(warnings.find((w) => w.includes("@emitTanstack"))!).toContain("Audit");
    // Attributes nobody wrote stay quiet.
    expect(warnings.some((w) => w.includes("@emitForm"))).toBe(false);
  });

  test("fires even when the generator it used to suppress is not wired", async () => {
    // The reason this lives in the runner. A generator-local check would go quiet in
    // exactly the project that dropped the generator and left the attribute behind — and
    // that attribute still fails `meta verify`.
    const root = await loadRoot(entity("Subscriber", { "@emitTanstack": false }));
    const warnings = await warningsFrom(root, [entityFile()]); // no tanstack generator here
    expect(warnings.some((w) => w.includes("@emitTanstack"))).toBe(true);
  });

  test("an INHERITED retired attribute is caught (ADR-0039: resolving, not own)", async () => {
    // An inherited flag suppressed emission exactly as an own one did, so an own-only
    // read here would leave the inheriting adopter unwarned while their output changed.
    const root = await loadRoot(
      {
        "object.entity": {
          name: "Base",
          abstract: true,
          "@emitRoutes": false,
          children: [{ "field.long": { name: "id" } }],
        },
      },
      {
        "object.entity": {
          name: "Child",
          extends: "Base",
          children: [
            { "source.rdb": { "@table": "children" } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
    );
    const warnings = await warningsFrom(root);
    const w = warnings.find((x) => x.includes("@emitRoutes"));
    expect(w).toBeDefined();
    expect(w!).toContain("Child");
  });

  test("`@emitForm: true` is just as stale as `false` — presence is what counts", async () => {
    // The read was `=== false`, so `true` turned nothing on. It still fails `meta verify`,
    // so a value-comparing warning would leave that adopter with a red gate and no hint.
    const warnings = await warningsFrom(await loadRoot(entity("Booking", { "@emitForm": true })));
    expect(warnings.some((w) => w.includes("@emitForm") && w.includes("Booking"))).toBe(true);
  });

  test("WARNS but does not fail: the routes file is emitted anyway", async () => {
    // The behaviour half. `@emitRoutes: false` used to suppress this file; it must not
    // now, and the run must not turn red for saying so.
    const root = await loadRoot(entity("Subscriber", { "@emitRoutes": false }));
    const dir = mkdtempSync(join(tmpdir(), "retired-attrs-emit-"));
    try {
      const res = await runGen({
        config: defineConfig({
          outDir: dir, extStyle: "none", dbImport: "../db", dialect: "sqlite",
          generators: [entityFile(), routesFile()],
        }),
        metadata: root,
      });
      expect(res.files.some((f) => f.path.endsWith("Subscriber.routes.ts"))).toBe(true);
      expect(res.conflicts).toEqual([]);
      expect(res.warnings.some((w) => w.includes("@emitRoutes"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the gate itself is a pure function of the entity set", async () => {
    // Called directly, so a future runner refactor that stops passing the right set is a
    // failure here rather than a silently-quiet warning.
    const root = await loadRoot(entity("Subscriber", { "@emitGrid": true }));
    const seen: string[] = [];
    warnRetiredCodegenAttrs(root.objects(), (m) => seen.push(m));
    expect(seen.length).toBe(1);
    expect(seen[0]!).toContain("@emitGrid");
    expect(seen[0]!).toContain("tphSubtypeGrids"); // the option, NOT `filter` — it widens

    const quiet: string[] = [];
    warnRetiredCodegenAttrs([], (m) => quiet.push(m));
    expect(quiet).toEqual([]);
  });
});
