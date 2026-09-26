// The client `<Entity>Filter` type narrows an enum field's filter VALUE to its members.
//
// 1.0.8 typed every enum filter value as a plain `string`, so `useIssues({ priority:
// "urgnet" })` compiled and was answered with an empty list. The OPERATOR band is not
// changed here: `like` on a string-backed enum is pinned cross-port by
// `fixtures/conformance/filter-ops-matrix` (`fEnum`), so it stays, and its pattern stays a
// plain string (a LIKE pattern is not a member). An int-backed enum (`@intValueMap`) has
// no `like` in its band, and still filters by member SYMBOL on the wire (runtime-ts maps
// the symbol to its integer), so it narrows the same way.
//
// Proven by compiling a consumer against the real generated module: every
// `@ts-expect-error` below must be USED (an unused one is TS2578), and the positive
// assignments must type-check.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";

const MODEL = {
  "metadata.root": {
    package: "tracker",
    children: [
      {
        "object.entity": {
          name: "Issue",
          children: [
            { "source.rdb": { "@table": "issues" } },
            { "field.long": { name: "id" } },
            {
              "field.enum": {
                name: "priority",
                "@values": ["low", "medium", "high"],
                "@filterable": true,
              },
            },
            {
              "field.enum": {
                name: "level",
                "@values": ["lo", "hi"],
                "@intValueMap": { lo: 0, hi: 1 },
                "@filterable": true,
              },
            },
            { "field.string": { name: "summary", "@filterable": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
};

const CONSUMER = `
import type { IssueFilter } from "./Issue";

export const ok: IssueFilter[] = [
  { priority: "low" },
  { priority: { eq: "high", ne: "medium", in: ["low", "high"], isNull: false } },
  // like stays in a string-backed enum's band (pinned cross-port), with a pattern value.
  { priority: { like: "l%" } },
  { level: "hi" },
  { level: { in: ["lo", "hi"] } },
  // a plain string field is unchanged.
  { summary: { like: "any%", eq: "whatever" } },
];

// @ts-expect-error — not a member of priority
export const bad1: IssueFilter = { priority: "urgnet" };
// @ts-expect-error — not a member, via eq
export const bad2: IssueFilter = { priority: { eq: "urgnet" } };
// @ts-expect-error — one non-member inside an in-list
export const bad3: IssueFilter = { priority: { in: ["low", "urgnet"] } };
// @ts-expect-error — an int-backed enum has no like in its band
export const bad4: IssueFilter = { level: { like: "h%" } };
// @ts-expect-error — an int-backed enum filters by member symbol, not the stored integer
export const bad5: IssueFilter = { level: 1 };
`;

describe("<Entity>Filter types an enum filter value as the enum's member union", () => {
  test("members compile, non-members are type errors", async () => {
    const loaded = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(loaded.errors.map((e) => e.message)).toEqual([]);
    const root = loaded.root;
    const dir = mkdtempSync(join(import.meta.dir, "tmp-filter-enum-"));
    try {
      const renderContext = makeRenderContext({
        dialect: "sqlite",
        loadedRoot: root,
        outDir: dir,
        dbImport: "~/db",
        pkMap: buildPkMap(root),
        relationMap: buildRelationMap(root),
      });
      const gen = entityFile({ allowlists: false });
      const ctx: GenContext = {
        entities: root.objects(),
        loadedRoot: root,
        matches: (e) => gen.filter?.(e) ?? true,
        projectRoot: dir,
        config: { outDir: dir, extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
        renderContext,
        warn: () => {},
      };
      const files = await gen.generate(ctx);
      for (const f of files) writeFileSync(join(dir, f.path), f.content);
      writeFileSync(join(dir, "consumer.ts"), CONSUMER);
      const program = ts.createProgram([join(dir, "consumer.ts")], {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
      });
      const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
        const where = d.file && d.start !== undefined
          ? `${d.file.fileName.slice(dir.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `
          : "";
        return `${where}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
      });
      expect(diagnostics).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
