// The api-contract `projection/` corpus, docs half: the REST routes a read-only
// projection's api page lists are exactly the routes its generated surface answers with
// a row. Every port runs the same assertion over the same model and the same expected
// set (fixtures/api-contract-conformance/projection/docs-routes.json):
//
//   - a projection with a declared identity lists `GET <path>` and `GET <path>/{id}`;
//   - one with none lists `GET <path>` alone, even when it has a field named `id`;
//   - no unit lists a write verb, because none is documented as a usable operation.
//
// The booted-server half of the same contract is the corpus scenarios themselves
// (`test/api-contract-projection.test.ts` in the integration-tests package).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { InMemoryStringSource, MetaDataLoader } from "@metaobjectsdev/metadata";
import { buildApiModel } from "../src/generators/api-model.js";

// test -> codegen-ts -> packages -> typescript -> server -> repo root
const CORPUS = join(resolve(import.meta.dir, "..", "..", "..", "..", ".."), "fixtures", "api-contract-conformance", "projection");

/** The spelling every port's expected set uses: no leading `/` or `/api` prefix, `{id}`. */
function normalize(symbol: string): string {
  return symbol.replace(/^(\w+) \/?(?:api\/)?/, "$1 ").replace(/:id\b/g, "{id}");
}

describe("api docs: the routes a read-only projection documents (projection/ corpus)", () => {
  const expected = JSON.parse(readFileSync(join(CORPUS, "docs-routes.json"), "utf8")) as {
    units: Record<string, string[]>;
  };

  test("each projection documents exactly the routes it mounts", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(readFileSync(join(CORPUS, "meta.json"), "utf8"), { id: "meta.json", format: "json" }),
    ]);
    expect(res.errors).toEqual([]);
    const model = buildApiModel(res.root, { loadedRoot: res.root });
    for (const [node, routes] of Object.entries(expected.units)) {
      const unit = model.units.find((u) => u.node === node);
      expect(unit).toBeDefined();
      const documented = unit!.symbols.filter((s) => s.kind === "rest").map((s) => normalize(s.name));
      expect({ node, documented: [...documented].sort() }).toEqual({ node, documented: [...routes].sort() });
    }
  });
});
