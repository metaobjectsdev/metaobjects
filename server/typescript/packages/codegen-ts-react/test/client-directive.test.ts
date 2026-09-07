// FR-040 §6.4 — the `clientDirective` config knob, on the generated FORM.
//
// The knob's sibling gate lives in codegen-ts-tanstack and covers `.hooks.ts`,
// `.columns.tsx` and `.grid.ts`. It cannot cover `.form.tsx`: `formFile` ships from this
// package, so nothing in the tanstack suite can reach it. The form was therefore the one
// client artifact whose knob nothing checked — and it is the artifact the RSC narrative
// in the design doc and the codegen skill both centre on, because a form is where hooks
// and event handlers actually appear.
//
// The equivalence gate next door does not close this. reference-byte-identical.test.ts
// compares the reference template against the built-in, and the two are near-verbatim
// forks — so dropping `withClientDirective` from BOTH (the natural edit when they are
// changed together) stays byte-identical and green while the knob silently stops
// working for every RSC adopter. Same shape as the gap the FR-040 review round was
// about: a thing shipped with the gate that would notice its absence missing.
//
// Both properties are asserted, matching the tanstack gate: OFF is byte-identical to
// before the knob existed, and ON puts the directive where a bundler honours it — first
// token of the module, ahead of the `@generated` header, exactly once.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/test-generators";
import { formFile } from "../src/index.js";
import { formFile as refFormFile } from "../src/reference/form.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "fixtures", "packaged-entity.json");

type FormFactory = typeof formFile;

async function gen(form: FormFactory, clientDirective: boolean | undefined): Promise<Record<string, string>> {
  const { root, errors } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  expect(errors).toEqual([]);
  const dir = mkdtempSync(join(tmpdir(), "react-client-directive-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: dir, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        ...(clientDirective === undefined ? {} : { clientDirective }),
        generators: [entityFile(), form()],
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

const isForm = (f: string): boolean => f.endsWith(".form.tsx");

// Run every case against BOTH halves. The reference template is what `meta eject form`
// hands an adopter, so a knob that works only in the packaged copy is a knob that stops
// working at exactly the moment FR-040 tells them to take ownership.
const HALVES: Array<[string, FormFactory]> = [
  ["built-in", formFile],
  ["reference template", refFormFile as FormFactory],
];

describe.each(HALVES)("clientDirective — %s form", (_label, form) => {
  test("omitted is byte-identical to explicitly false", async () => {
    expect(await gen(form, undefined)).toEqual(await gen(form, false));
  });

  test("off emits no directive anywhere", async () => {
    for (const [name, body] of Object.entries(await gen(form, false))) {
      expect({ name, hasDirective: body.includes("use client") })
        .toEqual({ name, hasDirective: false });
    }
  });

  test("on puts it first in every form, exactly once", async () => {
    const files = await gen(form, true);
    const forms = Object.keys(files).filter(isForm);
    // Guard against the assertions below going vacuous if the fixture stops emitting.
    expect(forms.length).toBeGreaterThan(0);

    for (const name of forms) {
      const body = files[name] as string;
      // FIRST token — ahead of the @generated header. A directive prologue is only
      // honoured before any other statement, and some bundlers want it before the
      // leading comment too.
      expect({ name, head: body.slice(0, 13) }).toEqual({ name, head: '"use client";' });
      expect({ name, count: body.split("use client").length - 1 }).toEqual({ name, count: 1 });
    }
  });

  test("on leaves the entity module untouched", async () => {
    const on = await gen(form, true);
    const off = await gen(form, false);
    const others = Object.keys(off).filter((f) => !isForm(f));
    expect(others.length).toBeGreaterThan(0);
    for (const name of others) {
      expect({ name, body: on[name] }).toEqual({ name, body: off[name] });
    }
  });
});
