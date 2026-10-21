import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

function doc(pkg: string, name: string, extendsRef?: string): InMemoryStringSource {
  return new InMemoryStringSource(
    JSON.stringify({
      "metadata.root": {
        package: pkg,
        children: [{ "object.value": { name, ...(extendsRef !== undefined ? { extends: extendsRef } : {}) } }],
      },
    }),
    { id: `meta.${pkg.replace(/::/g, ".")}.${name}.json`, format: "json" },
  );
}

describe("ERR_UNRESOLVED_SUPER names the fix", () => {
  test("a bare cross-package extends lists the candidate and the qualified spelling", async () => {
    const res = await new MetaDataLoader().load([doc("app::a", "Base"), doc("app::b", "Widget", "Base")]);
    const err = res.errors.find((e) => (e as { code?: string }).code === "ERR_UNRESOLVED_SUPER");
    expect(err).toBeDefined();
    expect(err!.message).toContain("app::a::Base");
    expect(err!.message).toContain('extends: "app::a::Base"');
  });

  test("no same-named object anywhere: no hint", async () => {
    const res = await new MetaDataLoader().load([doc("app::b", "Widget", "Nope")]);
    const err = res.errors.find((e) => (e as { code?: string }).code === "ERR_UNRESOLVED_SUPER");
    expect(err!.message).not.toContain("exists in");
  });
});
