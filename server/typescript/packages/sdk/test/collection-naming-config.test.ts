// `naming.collections` names the pluralizer an object without `@collectionName` takes its
// collection name from. The config reader accepts a registered pluralizer, refuses an unknown
// one when the file is read, and the loaded root carries the selection to `collectionNameOf`.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  InMemoryStringSource,
  MetaDataLoader,
  collectionNameOf,
  isMetaRoot,
  pluralizer,
  registerPluralizer,
  resetNamingStrategiesForTesting,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { loadConfig, physicalNamingFromConfig } from "../src/config.js";

const PLURALS = resolve(import.meta.dir, "../../../../../fixtures/naming-conformance/already-plural-pluralize.json");

afterEach(resetNamingStrategiesForTesting);

async function readConfigWith(naming: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "mo-collection-naming-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ schema_version: 1, naming }));
    return await loadConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function loadModel(): Promise<MetaRoot> {
  const json = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        { "object.entity": { name: "CaseHistory", children: [{ "field.long": { name: "id" } }] } },
        { "object.entity": { name: "Diagnosis", "@collectionName": "DiagnosisRows", children: [{ "field.long": { name: "id" } }] } },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(result.errors).toEqual([]);
  if (!isMetaRoot(result.root)) throw new Error("not a root");
  return result.root;
}

describe("naming.collections", () => {
  test("the standard pluralizer matches the shared naming-conformance corpus", () => {
    const corpus = JSON.parse(readFileSync(PLURALS, "utf8")) as { cases: { name: string; apiPlural: string }[] };
    expect(corpus.cases.length).toBeGreaterThan(0);
    for (const c of corpus.cases) expect([c.name, pluralizer("standard")(c.name)]).toEqual([c.name, c.apiPlural]);
  });

  test("the config reads a built-in and the root carries it to collectionNameOf", async () => {
    const config = await readConfigWith({ collections: "none" });
    expect(config.naming?.collections).toBe("none");
    const root = await loadModel();
    root.physicalNaming = physicalNamingFromConfig(config);
    expect(collectionNameOf(root.findObject("CaseHistory")!)).toBe("CaseHistory");
    expect(collectionNameOf(root.findObject("Diagnosis")!)).toBe("DiagnosisRows");
  });

  test("absent, an object takes the standard pluralizer", async () => {
    const config = await readConfigWith({ columns: "snake_case" });
    expect(physicalNamingFromConfig(config).collections).toBeUndefined();
    const root = await loadModel();
    root.physicalNaming = physicalNamingFromConfig(config);
    expect(collectionNameOf(root.findObject("CaseHistory")!)).toBe("CaseHistories");
  });

  test("an unknown pluralizer is refused when the config is read", async () => {
    await expect(readConfigWith({ collections: "latin" })).rejects.toThrow(/"naming\.collections" names "latin"/);
  });

  test("an application pluralizer is selectable by name", async () => {
    registerPluralizer("ts-test-shout", (n) => n.toUpperCase() + "S");
    const config = await readConfigWith({ collections: "ts-test-shout" });
    const root = await loadModel();
    root.physicalNaming = physicalNamingFromConfig(config);
    expect(collectionNameOf(root.findObject("CaseHistory")!)).toBe("CASEHISTORYS");
  });

  test("a built-in pluralizer cannot be replaced", () => {
    expect(() => registerPluralizer("none", (n) => n)).toThrow();
  });
});
