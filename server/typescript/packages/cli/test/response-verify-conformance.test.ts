// Runs the shared reply-check corpus (fixtures/response-verify-conformance/) against the
// TypeScript reference: what `meta verify --templates` reports about each prompt's
// `@responseRef`. Every port that ships a template gate runs this same file.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TYPE_TEMPLATE } from "@metaobjectsdev/metadata";
import { loadMemory } from "@metaobjectsdev/sdk";
import { responseFindings } from "../src/lib/response-verify.js";

interface Finding {
  readonly template: string;
  readonly code: string;
  readonly path: string;
  readonly severity: string;
}
interface Case {
  readonly name: string;
  readonly metadata: unknown;
  readonly expect: readonly Finding[];
}

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/response-verify-conformance/cases.json");
const cases = (JSON.parse(await readFile(CORPUS, "utf8")) as { cases: Case[] }).cases;
const scratch = await mkdtemp(join(process.env["DEV_SCRATCH"] ?? tmpdir(), "mo-reply-verify-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const order = (a: Finding, b: Finding): number =>
  `${a.template}\0${a.code}\0${a.path}`.localeCompare(`${b.template}\0${b.code}\0${b.path}`);

describe("response-verify-conformance", () => {
  test("the corpus is not empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(c.name, async () => {
      const file = join(scratch, `${c.name}.json`);
      await writeFile(file, JSON.stringify(c.metadata));
      const root = await loadMemory(scratch, { files: [file] });
      const got: Finding[] = root
        .children()
        .filter((t) => t.type === TYPE_TEMPLATE)
        .flatMap((t) => responseFindings(t).map((f) => ({ template: t.name, ...f })));
      expect(got.sort(order)).toEqual([...c.expect].sort(order));
    });
  }
});
