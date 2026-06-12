// Framework-level guard shared by every instance/write-artifact generator.
//
//   emitsInstanceArtifacts(e)  → false for abstract, true otherwise (incl. projections)
//   emitsWriteArtifacts(e)     → false for abstract OR projection, true otherwise
//
// Genericized `acme::*` fixtures: an abstract base + a concrete subclass +
// a read-only projection.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import {
  isAbstract,
  emitsInstanceArtifacts,
  emitsWriteArtifacts,
} from "../src/instance-artifacts.js";

async function loadMetadata(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "acme", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e: { message: string }) => e.message).join("\n")}`);
  }
  return result.root;
}

async function loadFixture() {
  const root = await loadMetadata([
    // Abstract base — contributes shape via inheritance only, never instantiable.
    {
      "object.entity": {
        name: "PartyBase",
        abstract: true,
        children: [
          { "field.int": { name: "id" } },
          { "field.string": { name: "displayName" } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
    // Concrete subclass — full instance + write artifacts.
    {
      "object.entity": {
        name: "Guest",
        extends: "PartyBase",
        children: [
          { "source.rdb": { "@table": "guests" } },
          { "field.string": { name: "email" } },
        ],
      },
    },
    // Read-only projection (extends a base + source.rdb @kind:view).
    {
      "object.entity": {
        name: "Host",
        children: [
          { "source.rdb": { "@table": "hosts" } },
          { "field.int": { name: "id" } },
          { "field.string": { name: "name" } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "HostSummary",
        extends: "Host",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_host_summary" } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
  ]);
  return {
    base: root.findObject("PartyBase")!,
    concrete: root.findObject("Guest")!,
    projection: root.findObject("HostSummary")!,
  };
}

describe("instance-artifacts guards", () => {
  test("isAbstract: true only for the abstract base", async () => {
    const { base, concrete, projection } = await loadFixture();
    expect(isAbstract(base)).toBe(true);
    expect(isAbstract(concrete)).toBe(false);
    expect(isAbstract(projection)).toBe(false);
  });

  test("emitsInstanceArtifacts: false for abstract, true for concrete + projection", async () => {
    const { base, concrete, projection } = await loadFixture();
    expect(emitsInstanceArtifacts(base)).toBe(false);
    expect(emitsInstanceArtifacts(concrete)).toBe(true);
    expect(emitsInstanceArtifacts(projection)).toBe(true); // read-only is still an instance for READ
  });

  test("emitsWriteArtifacts: false for abstract AND projection, true for concrete", async () => {
    const { base, concrete, projection } = await loadFixture();
    expect(emitsWriteArtifacts(base)).toBe(false);
    expect(emitsWriteArtifacts(projection)).toBe(false);
    expect(emitsWriteArtifacts(concrete)).toBe(true);
  });
});
