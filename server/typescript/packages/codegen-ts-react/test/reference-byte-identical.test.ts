// ADR-0034 verification, FR-040 §4.1: the copyable reference template
// (src/reference/form.ts) must produce BYTE-IDENTICAL output to the built-in
// generator it was relocated from. It imports only the PUBLIC engine
// (`@metaobjectsdev/codegen-ts` + `@metaobjectsdev/codegen-ts-react`); if this passes,
// a consumer can `meta eject form` and own it with no behaviour change.
//
// WHY THIS FILE EXISTS. `codegen-ts` has had this gate since ADR-0034 landed, covering
// the four templates `meta init` scaffolds. FR-040 added five more, and each is a
// near-verbatim fork of the shipped generator beside it. Without an equivalence gate,
// `src/reference/` is excluded from tsconfig, imported by nothing and executed by
// nothing — so `renderFormFile`'s signature, or the filter deciding WHICH entities get
// a form, can change with every lane green, and the first person to find out is an
// adopter running `meta eject form` against a build that no longer compiles, or one
// that compiles and silently emits a different entity set. A header substring
// assertion cannot see any of that; only running both halves can.
//
// The filter is the half most worth gating here: `formFile` skips abstract types and
// read-only projections, skips a TPH discriminator BASE while emitting for each
// concrete subtype, and honours `@emitForm: false`. The inline model below carries one
// of each, so a drifted filter changes the emitted file SET and fails loudly.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import type { Generator } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
import { formFile as builtinForm, REFERENCE_GENERATOR_NAMES } from "../src/index.js";
import { formFile as refForm } from "../src/reference/form.js";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const PACKAGED_FIXTURE = resolve(import.meta.dir, "fixtures", "packaged-entity.json");

// A plain writable entity, a read-only projection, an abstract value object and an
// entity opting out — i.e. one row per branch of formFile's filter.
const MIXED_MODEL = JSON.stringify({
  "metadata.root": {
    package: "demo",
    children: [
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "email", "@required": true, "@maxLength": 200 } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Muted", children: [
        { "source.rdb": { "@table": "muted" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "label", "@maxLength": 50 } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "attr.boolean": { name: "emitForm", "value": false } },
      ] } },
      { "object.value": { name: "Address", children: [
        { "field.string": { name: "city", "@maxLength": 80 } },
      ] } },
    ],
  },
});

/** Generate into a fresh temp dir and read the whole emitted tree back. */
async function gen(generators: Generator[], root: Parameters<typeof runGen>[0]["metadata"]) {
  const dir = mkdtempSync(join(tmpdir(), "react-ref-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: dir, extStyle: "none", dbImport: "../db", dialect: "sqlite", generators,
      }),
      metadata: root,
    });
    const out: Record<string, string> = {};
    for (const f of readdirSync(dir)) out[f] = readFileSync(join(dir, f), "utf-8");
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The names this file actually puts under the equivalence gate below.
const COVERED = ["form"] as const;

describe("ADR-0034 — the react reference template is byte-identical to the built-in", () => {
  // The gap this whole file was written to close is "a template ships with no gate",
  // so the gate has to notice its own coverage shrinking. Without this, a second
  // template added here is silently unverified — the way `form` itself was.
  test("every ejectable template in this package is covered", () => {
    expect([...COVERED].sort()).toEqual([...REFERENCE_GENERATOR_NAMES].sort());
  });

  const cases: Array<[string, () => Promise<Parameters<typeof runGen>[0]["metadata"]>]> = [
    ["packaged-entity.json", async () => {
      const { root, errors } = await new MetaDataLoader().load([new FileSource(PACKAGED_FIXTURE)]);
      expect(errors).toEqual([]);
      return root;
    }],
    ["mixed entity / opted-out / value object", async () => {
      const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(MIXED_MODEL)]);
      expect(errors).toEqual([]);
      return root;
    }],
  ];

  for (const [name, load] of cases) {
    test(name, async () => {
      const root = await load();
      // entityFile rides along on both sides so the form renders in the context a real
      // run gives it (its entity-module import resolves), and is identical either way.
      const a = await gen([entityFile(), builtinForm()], root);
      const b = await gen([entityFile(), refForm()], root);

      // Same set of files: catches a drifted FILTER (an entity that stops emitting).
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
      // Byte-identical contents: catches a drifted renderer or composition.
      for (const k of Object.keys(a).sort()) {
        expect(`${k}:\n${b[k]}`).toBe(`${k}:\n${a[k]}`);
      }
    });
  }
});
