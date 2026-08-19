// server/typescript/packages/codegen-ts/test/extract-tier-collision.test.ts
//
// ADR-0044 / #228 — the EXTRACT / OUTPUT-PARSER tier brings the runtime-delegating JSON extract
// path (extract-delegate-emitter.ts, extractor.ts, output-parser.ts) into the SAME collision
// scope Task 3 gave the entity tier: a value-object mirror interface / mapper / strict-payload
// type must use the ADR-0044 entity-domain EMITTED name (Task 3's `valueObjectEmittedName`), and
// the dedupe walks (mirror interfaces, mappers, reachable payload groups, used-helper / has-nested
// scans) must key on `resolutionKey()` — NOT the bare metadata `name` — so a second same-bare-named
// value-object across packages is never silently dropped.
//
// Two proofs:
//  1. The shared JSON collision fixture (fixtures/template-output-render-conformance/
//     xpkg-collision-json/) — a Digest payload with two field.object children pointing at
//     cross-package same-short-name `Note`s — must emit/import the SAME qualified names Task 3's
//     entity tier emits (`AcmeAlphaNote` / `AcmeBetaNote`, never bare `Note`), with BOTH mirror
//     interfaces + mappers present (not one dropped), and the generated code must actually RUN
//     and extract each nested object into its OWN shape (not the other's).
//  2. An inline PAYLOAD-level bare-name collision (two `Report`s in two packages, each its own
//     template's @payloadRef) proves the output-parser.ts runtime-lookup fix: `root.findObject()`
//     (MetaRoot's public runtime API) is a bare-name-only, first-match lookup, so a payload whose
//     OWN bare name collides could resolve to the WRONG package's object at runtime, load-order
//     dependent. Fixed by baking the FQN + resolving via the canonical ADR-0042 `resolveObjectRef`
//     when (and only when) the payload's own name collides.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { entityFile } from "../src/generators/entity-file.js";
import { outputParser } from "../src/generators/output-parser-file.js";
import { extractor } from "../src/generators/extractor-file.js";

const CORPUS = resolve(
  import.meta.dir,
  "../../../../../fixtures/template-output-render-conformance/xpkg-collision-json",
);

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

async function loadCorpusRoot() {
  const sources = ["meta.alpha.json", "meta.beta.json", "meta.app.json"].map(
    (f) => new InMemoryStringSource(readFileSync(join(CORPUS, f), "utf-8")),
  );
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors).toEqual([]);
  return res.root;
}

async function genFiles(
  root: Awaited<ReturnType<typeof loadCorpusRoot>>,
  dir: string,
): Promise<Map<string, string>> {
  const result = await runGen({
    config: defineConfig({
      outDir: dir,
      extStyle: "js",
      dbImport: "../db",
      dialect: "postgres",
      generators: [entityFile(), outputParser(), extractor()],
    }),
    metadata: root,
  });
  expect(result.conflicts).toEqual([]);
  const out = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    out.set(name, readFileSync(join(dir, name), "utf8"));
  }
  return out;
}

describe("extract/output-parser tier — ADR-0044 cross-package collision (#228)", () => {
  test("xpkg-collision-json: extractor + output-parser use the entity-domain qualified names; both mirrors+mappers emitted; generated code extracts each nested VO into its OWN shape", async () => {
    const root = await loadCorpusRoot();
    const dir = mkdtempSync(join(import.meta.dir, "extract-tier-xpkg-"));
    TEMP_DIRS.push(dir);

    const files = await genFiles(root, dir);
    const names = [...files.keys()].sort();

    // Entity tier (Task 3) — distinct qualified modules, never a collision-losing Note.ts.
    expect(names).toContain("AcmeAlphaNote.ts");
    expect(names).toContain("AcmeBetaNote.ts");
    expect(names).not.toContain("Note.ts");

    const outputSrc = files.get("DigestDoc.output.ts")!;
    const extractorSrc = files.get("DigestDoc.extractor.ts")!;

    // Mirror interfaces for BOTH colliding VOs present — neither dropped by bare-name dedupe.
    expect(outputSrc).toContain("export interface AcmeAlphaNoteExtracted {");
    expect(outputSrc).toContain("export interface AcmeBetaNoteExtracted {");
    expect(outputSrc).not.toContain("export interface NoteExtracted {");
    expect(outputSrc).toMatch(/alphaText:\s*string \| null;/);
    expect(outputSrc).toMatch(/betaText:\s*string \| null;/);

    // Mappers for BOTH present, each reading its own shape.
    expect(outputSrc).toContain("function fromAcmeAlphaNoteExtracted(");
    expect(outputSrc).toContain("function fromAcmeBetaNoteExtracted(");
    expect(outputSrc).not.toContain("function fromNoteExtracted(");

    // The root Digest mirror references the qualified nested mirror types.
    expect(outputSrc).toMatch(/fromAlpha:\s*AcmeAlphaNoteExtracted \| null;/);
    expect(outputSrc).toMatch(/fromBeta:\s*AcmeBetaNoteExtracted \| null;/);

    // extractor.ts imports the entity-domain qualified modules (Task 3's entityFile() output) —
    // never a bare `./Note.js`.
    expect(extractorSrc).toContain("./AcmeAlphaNote.js");
    expect(extractorSrc).toContain("./AcmeBetaNote.js");
    expect(extractorSrc).toContain("./Digest.js");
    expect(extractorSrc).not.toContain("./Note.js");

    // No bare "Note" identifier/type token anywhere in either generated file (word-boundary —
    // `AcmeAlphaNote`/`AcmeBetaNote` do NOT match \bNote\b since "a"/"N" share no boundary).
    expect(outputSrc).not.toMatch(/\bNote\b/);
    expect(extractorSrc).not.toMatch(/\bNote\b/);

    // ---- Compile + RUN the generated output ----
    const extractorMod = await import(join(dir, "DigestDoc.extractor.ts"));

    const text = JSON.stringify({
      fromAlpha: { alphaText: "AA" },
      fromBeta: { betaText: "BB" },
    });

    // Tolerant delegating extract (output-parser.ts) — never throws.
    const { data, report } = extractorMod.extractLenientDigestDoc(root, text);
    expect(report.lostRequired()).toEqual([]);
    expect(data.fromAlpha).toEqual({ alphaText: "AA" });
    expect(data.fromBeta).toEqual({ betaText: "BB" });

    // Strict extract (extractor.ts) — throws iff a required field was lost; asserts full type
    // fidelity end-to-end (entity module + output-parser + extractor all agree).
    const strict = extractorMod.extractDigestDoc(root, text);
    expect(strict.fromAlpha).toEqual({ alphaText: "AA" });
    expect(strict.fromBeta).toEqual({ betaText: "BB" });
  });

  test("no-churn — a non-colliding template.output payload keeps bare names (qualification never fires)", async () => {
    const root = await (async () => {
      const meta = {
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.value": {
                name: "Widget",
                children: [{ "field.string": { name: "label", "@required": true } }],
              },
            },
            {
              "template.prompt": {
                name: "WidgetOut",
                "@payloadRef": "Widget",
          "@responseRef": "Widget",
                "@textRef": "x/y",
              },
            },
          ],
        },
      };
      const res = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(meta))]);
      expect(res.errors).toEqual([]);
      return res.root;
    })();

    const dir = mkdtempSync(join(import.meta.dir, "extract-tier-nochurn-"));
    TEMP_DIRS.push(dir);
    const files = await genFiles(root, dir);

    expect([...files.keys()]).toContain("Widget.ts");
    expect([...files.keys()]).not.toContain("DemoWidget.ts");

    const outputSrc = files.get("WidgetOut.output.ts")!;
    expect(outputSrc).toContain("export interface WidgetOutExtracted {");
    expect(outputSrc).toContain('export const WIDGETOUT_PAYLOAD_NAME = "Widget";');
    expect(outputSrc).toContain("root.findObject(WIDGETOUT_PAYLOAD_NAME)");
    expect(outputSrc).not.toContain("resolveObjectRef");

    const extractorSrc = files.get("WidgetOut.extractor.ts")!;
    expect(extractorSrc).toContain("./Widget.js");
    expect(extractorSrc).not.toContain("DemoWidget");
  });
});

describe("output-parser runtime payload lookup — ADR-0042 FQN fix for a colliding @payloadRef (#228)", () => {
  test("two templates whose OWN @payloadRef bare-collides (`Report`/`Report` across packages) each extract via THEIR OWN VO at runtime, never the other's", async () => {
    const sources = [
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme::alpha",
            children: [
              {
                "object.value": {
                  name: "Report",
                  children: [{ "field.string": { name: "alphaVal", "@required": true } }],
                },
              },
              {
                "template.prompt": {
                  name: "ReportDocAlpha",
                  "@payloadRef": "Report",
          "@responseRef": "Report",
                  "@textRef": "unused/a",
                },
              },
            ],
          },
        }),
      ),
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme::beta",
            children: [
              {
                "object.value": {
                  name: "Report",
                  children: [{ "field.string": { name: "betaVal", "@required": true } }],
                },
              },
              {
                "template.prompt": {
                  name: "ReportDocBeta",
                  "@payloadRef": "Report",
          "@responseRef": "Report",
                  "@textRef": "unused/b",
                },
              },
            ],
          },
        }),
      ),
    ];
    const res = await new MetaDataLoader().load(sources);
    expect(res.errors).toEqual([]);
    const root = res.root;

    const dir = mkdtempSync(join(import.meta.dir, "extract-tier-payload-collision-"));
    TEMP_DIRS.push(dir);
    const files = await genFiles(root, dir);

    const alphaOut = files.get("ReportDocAlpha.output.ts")!;
    const betaOut = files.get("ReportDocBeta.output.ts")!;

    // The payload's OWN bare name ("Report") collides -> the FQN is baked + resolved via the
    // canonical resolveObjectRef, NOT the ambiguous bare root.findObject().
    expect(alphaOut).toContain('export const REPORTDOCALPHA_PAYLOAD_NAME = "acme::alpha::Report";');
    expect(alphaOut).toContain("resolveObjectRef(root, REPORTDOCALPHA_PAYLOAD_NAME, \"\").node");
    expect(alphaOut).toContain('import { resolveObjectRef } from "@metaobjectsdev/metadata";');

    expect(betaOut).toContain('export const REPORTDOCBETA_PAYLOAD_NAME = "acme::beta::Report";');
    expect(betaOut).toContain("resolveObjectRef(root, REPORTDOCBETA_PAYLOAD_NAME, \"\").node");

    // ---- Compile + RUN both against the SAME shared root ----
    const alphaMod = await import(join(dir, "ReportDocAlpha.output.ts"));
    const betaMod = await import(join(dir, "ReportDocBeta.output.ts"));

    const alphaText = JSON.stringify({ alphaVal: "AV" });
    const betaText = JSON.stringify({ betaVal: "BV" });

    const alphaResult = alphaMod.extractLenientReportDocAlphaWithLoader(root, alphaText);
    expect(alphaResult.report.lostRequired()).toEqual([]);
    expect(alphaResult.data).toEqual({ alphaVal: "AV" });

    const betaResult = betaMod.extractLenientReportDocBetaWithLoader(root, betaText);
    expect(betaResult.report.lostRequired()).toEqual([]);
    expect(betaResult.data).toEqual({ betaVal: "BV" });
  });
});
