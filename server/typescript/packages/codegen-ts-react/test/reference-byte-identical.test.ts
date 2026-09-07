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
// read-only projections, and skips a TPH discriminator BASE while emitting for each
// concrete subtype. The inline model below carries one of each, so a drifted filter
// changes the emitted file SET and fails loudly.
//
// It used to carry a fourth row instead of the TPH pair: an entity opting out via an
// `emitForm` attribute. That attribute was never registered metamodel vocabulary — the
// strict loader `meta verify` runs rejects it — so no generator reads it any more, and
// the row proved nothing about a branch that still exists. The TPH pair it was replaced
// with covers two branches the header above had ALREADY claimed and the model did not
// actually contain.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import type { Generator } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/test-generators";
import { formFile as builtinForm, REFERENCE_GENERATOR_NAMES } from "../src/index.js";
import type { ReferenceGeneratorName } from "../src/index.js";
import { formFile as refForm } from "../src/reference/form.js";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const PACKAGED_FIXTURE = resolve(import.meta.dir, "fixtures", "packaged-entity.json");

// A plain writable entity, a TPH discriminator base (no form) with one concrete subtype
// (a form), and a value object — i.e. one row per branch of formFile's filter.
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
      { "object.entity": { name: "Payment", "@discriminator": "kind", children: [
        { "source.rdb": { "@table": "payments" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "kind", "@values": ["Card", "Cash"] } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "CardPayment", extends: "Payment", "@discriminatorValue": "Card",
        children: [{ "field.string": { name: "last4", "@maxLength": 4 } }] } },
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

// Per ejectable name, the pair this file runs. Keyed by name and typed as a Record over
// the name union, so coverage is STRUCTURAL rather than a parallel list asserted equal:
// adding a template to REFERENCE_GENERATOR_NAMES makes this object fail to COMPILE until
// its pair is supplied, and the pair IS the wiring. A hand-maintained `COVERED` array
// could be satisfied by editing one line without adding any verification — proving the
// list was touched, not that the generator was tested. Degenerate at one entry today;
// the point is the SECOND one, which is where the old form would have gone wrong.
const PAIRS: Record<ReferenceGeneratorName, { builtin: () => Generator; ref: () => Generator }> = {
  form: { builtin: builtinForm, ref: refForm },
};

describe("ADR-0034 — the react reference template is byte-identical to the built-in", () => {
  // The gap this whole file was written to close is "a template ships with no gate",
  // so the gate has to notice its own coverage shrinking. Without this, a second
  // template added here is silently unverified — the way `form` itself was.
  test("every ejectable template in this package is covered", () => {
    expect(Object.keys(PAIRS).sort()).toEqual([...REFERENCE_GENERATOR_NAMES].sort());
  });

  // Each case carries the form files it MUST emit — so the fixture's filter branches are
  // load-bearing rather than decorative. Without this, a filter that emitted a form for
  // every object (or for none) would still be identical on both sides and pass:
  // equivalence is not correctness.
  const cases: Array<[string, () => Promise<Parameters<typeof runGen>[0]["metadata"]>, string[], string[]]> = [
    ["packaged-entity.json", async () => {
      const { root, errors } = await new MetaDataLoader().load([new FileSource(PACKAGED_FIXTURE)]);
      expect(errors).toEqual([]);
      return root;
    }, ["Product.form.tsx"], []],
    ["mixed entity / TPH base + subtype / value object", async () => {
      const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(MIXED_MODEL)]);
      expect(errors).toEqual([]);
      return root;
    },
      // A writable entity and a concrete TPH subtype get a form …
      ["Customer.form.tsx", "CardPayment.form.tsx"],
      // … a value object and a TPH discriminator base never do.
      ["Address.form.tsx", "Payment.form.tsx"]],
  ];

  for (const [name, load, mustEmit, mustNotEmit] of cases) {
    test(name, async () => {
      const root = await load();
      // entityFile rides along on both sides so the form renders in the context a real
      // run gives it (its entity-module import resolves), and is identical either way.
      const a = await gen([entityFile(), ...Object.values(PAIRS).map((p) => p.builtin())], root);
      const b = await gen([entityFile(), ...Object.values(PAIRS).map((p) => p.ref())], root);

      // Same set of files: catches a drifted FILTER (an entity that stops emitting).
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
      // …and this case's filter branches are LIVE (see the case table).
      const forms = Object.keys(a).filter((f) => f.endsWith(".form.tsx")).sort();
      for (const f of mustEmit) expect(forms).toContain(f);
      for (const f of mustNotEmit) expect(forms).not.toContain(f);
      // Byte-identical contents: catches a drifted renderer or composition.
      for (const k of Object.keys(a).sort()) {
        expect(`${k}:\n${b[k]}`).toBe(`${k}:\n${a[k]}`);
      }
    });
  }
});
