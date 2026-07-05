import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeId, TYPE_FIELD, MetaField } from "@metaobjectsdev/metadata";
import type { MetaDataTypeProvider } from "@metaobjectsdev/metadata";
import { generateSite } from "../src/site";
import { loadModel } from "../src/load";

// A consumer-supplied provider registering a custom field subtype the built-in
// bundle (core-types/db/doc/prompt/ui) does not know — mirrors how an adopter
// ships custom vocabulary via metaobjects.config.ts `providers`.
function geoProvider(): MetaDataTypeProvider {
  return {
    id: "test-geo",
    dependencies: ["metaobjects-core-types"],
    registerTypes(registry) {
      registry.register({
        typeId: new TypeId(TYPE_FIELD, "geopoint"),
        description: "A geographic point field",
        factory: (typeId, name) => new MetaField(typeId, name),
        childRules: [],
        attributes: [],
      });
    },
  };
}

// Metadata whose `field.geopoint` resolves ONLY when geoProvider is registered.
function customTypeDir(): string {
  const root = mkdtempSync(join(tmpdir(), "docs-extra-prov-"));
  const acme = join(root, "acme");
  mkdirSync(acme, { recursive: true });
  writeFileSync(
    join(acme, "place.yaml"),
    [
      "metadata:",
      "  package: acme::geo",
      "  children:",
      "    - object.value:",
      "        name: Place",
      "        children:",
      "          - field.string: { name: name }",
      "          - field.geopoint: { name: location }",
      "",
    ].join("\n"),
    "utf8",
  );
  return acme;
}

test("loadModel: a custom subtype fails without its provider, resolves with extraProviders", async () => {
  const dir = customTypeDir();
  // Without the provider the loader rejects the unknown subtype (the exact
  // failure a consumer hit running docs over metadata with custom view/field types).
  await expect(loadModel([dir])).rejects.toThrow(/geopoint|not registered|Unknown type/i);
  // Threading the provider through extraProviders resolves it.
  const model = await loadModel([dir], [geoProvider()]);
  expect(model.root.objects().map((o) => o.name)).toContain("Place");
});

test("generateSite: extraProviders lets a site document custom-subtype metadata", async () => {
  const dir = customTypeDir();
  const out = mkdtempSync(join(tmpdir(), "docs-extra-out-"));
  const r = await generateSite({
    sourceDirs: [dir],
    outDir: out,
    title: "Fixture",
    stamp: "2026-01-01",
    commit: "abc1234",
    extraProviders: [geoProvider()],
  });
  expect(existsSync(join(out, "index.html"))).toBe(true);
  expect(r.dangling).toEqual([]);
});
