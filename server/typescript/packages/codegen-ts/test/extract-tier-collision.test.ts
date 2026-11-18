// server/typescript/packages/codegen-ts/test/extract-tier-collision.test.ts
//
// ADR-0044 / #228, amended — the EXTRACT / OUTPUT-PARSER tier (the runtime-delegating
// JSON extract path: extract-delegate-emitter.ts, extractor.ts, output-parser.ts) over two value
// objects that share a short name. No type is renamed: each `Note` keeps its name in its own
// package's module (the package output layout). A file that meets both binds each under a
// package-qualified LOCAL alias (`Note as AcmeAlphaNote`), and the mirrors and mappers — this
// one module's own declarations — are named by that local name. The dedupe walks key on
// `resolutionKey()`, never the bare `name`, so the second Note is never silently dropped.
//
// Two proofs:
//  1. The shared JSON collision fixture (fixtures/template-output-render-conformance/
//     xpkg-collision-json/): both mirrors + mappers present, and the generated code RUNS and
//     extracts each nested object into its OWN shape.
//  2. A PAYLOAD-level bare-name collision (two `Report`s in two packages, each its own
//     template's @payloadRef) proves the output-parser.ts runtime lookup bakes the FQN and
//     resolves it via `resolveObjectRef` when (and only when) the payload's own name is shared.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
  outputLayout: "flat" | "package" = "flat",
): Promise<Map<string, string>> {
  const result = await runGen({
    config: defineConfig({
      outDir: dir,
      extStyle: "js",
      dbImport: "../db",
      dialect: "postgres",
      outputLayout,
      generators: [entityFile(), outputParser(), extractor()],
    }),
    metadata: root,
  });
  expect(result.conflicts).toEqual([]);
  const out = new Map<string, string>();
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out.set(relative(dir, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8"));
  }
  return out;
}

describe("extract/output-parser tier — ADR-0044 cross-package collision (#228)", () => {
  test("xpkg-collision-json: both Notes keep their name in their own package's module; the extract tier binds each under a local alias; both mirrors+mappers emitted; generated code extracts each nested VO into its OWN shape", async () => {
    const root = await loadCorpusRoot();
    const dir = mkdtempSync(join(import.meta.dir, "extract-tier-xpkg-"));
    TEMP_DIRS.push(dir);

    // the package layout — two Notes are two modules; nothing is renamed.
    const files = await genFiles(root, dir, "package");
    const names = [...files.keys()].sort();

    expect(names).toContain("acme/alpha/Note.ts");
    expect(names).toContain("acme/beta/Note.ts");
    expect(files.get("acme/alpha/Note.ts")).toContain("export interface Note {");
    expect(files.get("acme/beta/Note.ts")).toContain("export interface Note {");

    const outputSrc = files.get("DigestPrompt.response.ts")!;
    const extractorSrc = files.get("DigestPrompt.extractor.ts")!;

    // Mirror interfaces for BOTH value objects — declarations of this one module, so each is
    // named by its value object's local name; neither dropped by bare-name dedupe.
    expect(outputSrc).toContain("export interface AcmeAlphaNoteExtracted {");
    expect(outputSrc).toContain("export interface AcmeBetaNoteExtracted {");
    expect(outputSrc).not.toContain("export interface NoteExtracted {");
    expect(outputSrc).toMatch(/alphaText:\s*string \| null;/);
    expect(outputSrc).toMatch(/betaText:\s*string \| null;/);

    // Mappers for BOTH present, each reading its own shape.
    expect(outputSrc).toContain("function fromAcmeAlphaNoteExtracted(");
    expect(outputSrc).toContain("function fromAcmeBetaNoteExtracted(");

    // The root Digest mirror references the nested mirror types.
    expect(outputSrc).toMatch(/fromAlpha:\s*AcmeAlphaNoteExtracted \| null;/);
    expect(outputSrc).toMatch(/fromBeta:\s*AcmeBetaNoteExtracted \| null;/);

    // extractor.ts imports each Note from its own package's module, under a local alias.
    expect(extractorSrc).toContain('import type { Note as AcmeAlphaNote } from "./acme/alpha/Note.js";');
    expect(extractorSrc).toContain('import type { Note as AcmeBetaNote } from "./acme/beta/Note.js";');
    expect(extractorSrc).toContain("./acme/app/Digest.js");

    // ---- Compile + RUN the generated output ----
    const extractorMod = await import(join(dir, "DigestPrompt.extractor.ts"));

    const text = JSON.stringify({
      fromAlpha: { alphaText: "AA" },
      fromBeta: { betaText: "BB" },
    });

    // Tolerant delegating extract (output-parser.ts) — never throws.
    const { data, report } = extractorMod.extractLenientDigestPrompt(root, text);
    expect(report.lostRequired()).toEqual([]);
    expect(data.fromAlpha).toEqual({ alphaText: "AA" });
    expect(data.fromBeta).toEqual({ betaText: "BB" });

    // Strict extract (extractor.ts) — throws iff a required field was lost; asserts full type
    // fidelity end-to-end (entity module + output-parser + extractor all agree).
    const strict = extractorMod.extractDigestPrompt(root, text);
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

    const outputSrc = files.get("WidgetOut.response.ts")!;
    // ADR-0056: the mirror is named for the value object (Widget), not the template.
    expect(outputSrc).toContain("export interface WidgetExtracted {");
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
    // Two value objects named Report: one module per package.
    const files = await genFiles(root, dir, "package");

    const alphaOut = files.get("ReportDocAlpha.response.ts")!;
    const betaOut = files.get("ReportDocBeta.response.ts")!;

    // The payload's OWN bare name ("Report") collides -> the FQN is baked + resolved via the
    // canonical resolveObjectRef, NOT the ambiguous bare root.findObject().
    expect(alphaOut).toContain('export const REPORTDOCALPHA_PAYLOAD_NAME = "acme::alpha::Report";');
    expect(alphaOut).toContain("resolveObjectRef(root, REPORTDOCALPHA_PAYLOAD_NAME, \"\").node");
    expect(alphaOut).toContain('import { resolveObjectRef } from "@metaobjectsdev/metadata";');

    expect(betaOut).toContain('export const REPORTDOCBETA_PAYLOAD_NAME = "acme::beta::Report";');
    expect(betaOut).toContain("resolveObjectRef(root, REPORTDOCBETA_PAYLOAD_NAME, \"\").node");

    // ---- Compile + RUN both against the SAME shared root ----
    const alphaMod = await import(join(dir, "ReportDocAlpha.response.ts"));
    const betaMod = await import(join(dir, "ReportDocBeta.response.ts"));

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
