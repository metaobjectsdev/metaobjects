// FR-023 Task 7 — lock and manifest schemas, integrity hashing. Pure schemas
// and helpers only: nothing here resolves a dependency to bytes on disk or
// consumes these types (the collection resolver is a later task). See
// docs/superpowers/specs/2026-09-11-fr-023-metadata-dependencies-design.md
// §3.2 (manifest), §3.3 (lock, minus `mode` — DESIGN §11.1/§11.3).
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { LockSchema, ManifestSchema, sha256Integrity } from "../src/dependencies.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/dependency-conformance/artifacts");

test("sha256Integrity of the pinned v1 artifact equals the README value", async () => {
  expect(sha256Integrity(await readFile(`${CORPUS}/acme-common-v1.json`))).toBe(
    "sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d",
  );
});

test("manifest and lock schemas: sorted arrays, sorted keys, one transport", () => {
  const manifest = {
    schema_version: 1,
    name: "acme-common",
    version: "1.0.0",
    metamodelVersion: "1.0",
    artifact: "acme-common.metaobjects.json",
    integrity: "sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d",
    packages: ["acme::common"],
    nodes: ["acme::common::Address", "acme::common::Audited", "acme::common::Customer"],
  };
  expect(() => ManifestSchema.parse(manifest)).not.toThrow();
  expect(() => ManifestSchema.parse({ ...manifest, nodes: ["b", "a"] })).toThrow(/sorted/);
  expect(() => ManifestSchema.parse({ ...manifest, mode: "reference" })).toThrow();

  const { schema_version: _s, name: _n, ...rest } = manifest;
  const entry = { ...rest, resolvedFrom: { path: "x" } };
  expect(() =>
    LockSchema.parse({ schema_version: 1, dependencies: { "acme-common": entry } }),
  ).not.toThrow();
  expect(() =>
    LockSchema.parse({ schema_version: 1, dependencies: { b: entry, a: entry } }),
  ).toThrow(/sorted/);
  expect(() =>
    LockSchema.parse({
      schema_version: 1,
      dependencies: { a: { ...entry, resolvedFrom: { path: "x", npm: "y" } } },
    }),
  ).toThrow();
  expect(() =>
    LockSchema.parse({ schema_version: 1, dependencies: { a: { ...entry, mode: "own" } } }),
  ).toThrow();
});
