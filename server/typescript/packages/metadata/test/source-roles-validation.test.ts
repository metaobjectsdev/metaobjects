import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

async function loadDoc(doc: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
}
const codesOf = (errors: readonly Error[]) => errors.map((e) => (e as { code?: string }).code);
const entityWithSources = (sources: unknown[]) => ({
  "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "P", children: [
      ...sources,
      { "field.long": { name: "id" } },
      { "identity.primary": { "name": "id", "@fields": "id" } },
    ] } },
  ] },
});

describe("one-primary source-role validation", () => {
  test("single source (default role = primary) → OK", async () => {
    const { errors } = await loadDoc(entityWithSources([
      { "source.rdb": { "@table": "p" } },
    ]));
    expect(codesOf(errors)).not.toContain("ERR_SOURCE_NO_PRIMARY");
    expect(codesOf(errors)).not.toContain("ERR_SOURCE_MULTIPLE_PRIMARY");
  });

  test("primary + replica (explicit) → OK", async () => {
    const { errors } = await loadDoc(entityWithSources([
      { "source.rdb": { "@table": "p" } },
      { "source.rdb": { "@table": "v_p", "@kind": "view", "@role": "replica" } },
    ]));
    expect(codesOf(errors)).not.toContain("ERR_SOURCE_NO_PRIMARY");
    expect(codesOf(errors)).not.toContain("ERR_SOURCE_MULTIPLE_PRIMARY");
  });

  test("zero sources → OK (object isn't persisted)", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "P", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
      ] } },
    ] } });
    expect(codesOf(errors)).not.toContain("ERR_SOURCE_NO_PRIMARY");
    expect(codesOf(errors)).not.toContain("ERR_SOURCE_MULTIPLE_PRIMARY");
  });

  test("no primary (only replica) → ERR_SOURCE_NO_PRIMARY", async () => {
    const { errors } = await loadDoc(entityWithSources([
      { "source.rdb": { "@table": "p", "@role": "replica" } },
    ]));
    expect(codesOf(errors)).toContain("ERR_SOURCE_NO_PRIMARY");
  });

  test("two primaries → ERR_SOURCE_MULTIPLE_PRIMARY", async () => {
    const { errors } = await loadDoc(entityWithSources([
      { "source.rdb": { "@table": "p" } },
      { "source.rdb": { "@table": "q" } },
    ]));
    expect(codesOf(errors)).toContain("ERR_SOURCE_MULTIPLE_PRIMARY");
  });
});
