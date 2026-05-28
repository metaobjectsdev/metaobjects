import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, InMemoryProvider, type RenderFormat } from "../src/index.js";

// Render-conformance corpus: each fixture dir holds
//   meta.json          { "format": "<RenderFormat>" }
//   template.mustache  the entry template
//   partials/*.mustache  optional partials, referenced as `partials/<name>`
//   payload.json       the render payload (pre-formatted primitives)
//   expected.txt       byte-exact expected output
// The same (payload + template) MUST produce expected.txt byte-for-byte.
const CORPUS = join(import.meta.dir, "../../../../../fixtures/render-conformance");

function providerFromPartials(dir: string): InMemoryProvider {
  const map: Record<string, string> = {};
  const pdir = join(dir, "partials");
  if (existsSync(pdir)) {
    for (const f of readdirSync(pdir)) {
      if (f.endsWith(".mustache")) {
        map[`partials/${f.replace(/\.mustache$/, "")}`] = readFileSync(join(pdir, f), "utf8");
      }
    }
  }
  return new InMemoryProvider(map);
}

describe("render-conformance corpus", () => {
  // Skip sub-corpora that live alongside the flat render-conformance fixtures
  // (e.g. fixtures/render-conformance/template-generator/) — those have their
  // own harness and schema.
  const names = existsSync(CORPUS)
    ? readdirSync(CORPUS)
        .filter((n) => statSync(join(CORPUS, n)).isDirectory())
        .filter((n) => existsSync(join(CORPUS, n, "template.mustache")))
    : [];
  expect(names.length).toBeGreaterThan(0);

  for (const name of names) {
    test(name, () => {
      const dir = join(CORPUS, name);
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { format: RenderFormat };
      const template = readFileSync(join(dir, "template.mustache"), "utf8");
      const payload = JSON.parse(readFileSync(join(dir, "payload.json"), "utf8"));
      const expected = readFileSync(join(dir, "expected.txt"), "utf8");
      const provider = providerFromPartials(dir);
      const actual = render({ template, payload, provider, format: meta.format });
      expect(actual).toBe(expected);
      // determinism: identical across runs
      expect(render({ template, payload, provider, format: meta.format })).toBe(actual);
    });
  }
});
