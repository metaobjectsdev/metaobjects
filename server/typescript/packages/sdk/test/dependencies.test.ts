// FR-023 Task 7 — lock and manifest schemas, integrity hashing. Pure schemas
// and helpers only: nothing here resolves a dependency to bytes on disk or
// consumes these types (the collection resolver is a later task). See
// docs/superpowers/specs/2026-09-11-fr-023-metadata-dependencies-design.md
// §3.2 (manifest), §3.3 (lock, minus `mode` — DESIGN §11.1/§11.3).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  dependencySourceId,
  LOCK_FILE,
  LockSchema,
  ManifestSchema,
  readLock,
  sha256Integrity,
  writeLock,
  type Lock,
} from "../src/dependencies.js";
import { DEFAULT_METAOBJECTS_DIR } from "../src/metadata-files.js";

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

test("dependencySourceId is dep:<name>/<artifact>", () => {
  expect(dependencySourceId("acme-common", "acme-common.metaobjects.json")).toBe(
    "dep:acme-common/acme-common.metaobjects.json",
  );
});

const PINNED_INTEGRITY = "sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d";

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "metaobjects-deps-lock-"));
  mkdirSync(join(projectRoot, DEFAULT_METAOBJECTS_DIR), { recursive: true });
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

test("readLock returns undefined when no lock file exists", async () => {
  expect(await readLock(projectRoot)).toBeUndefined();
});

test("writeLock: exact on-disk bytes — sorted keys, 2-space indent, trailing newline, no host paths/timestamps", async () => {
  // Deliberately out-of-order insertion ("b-dep" before "a-dep") — writeLock
  // must sort regardless of the caller's own map order.
  const entryA = {
    version: "1.0.0",
    metamodelVersion: "1.0",
    artifact: "a.metaobjects.json",
    integrity: PINNED_INTEGRITY,
    packages: ["acme::a"],
    nodes: ["acme::a::Foo"],
    resolvedFrom: { path: "../a" },
  };
  const entryB = {
    version: "2.0.0",
    metamodelVersion: "1.0",
    artifact: "b.metaobjects.json",
    integrity: PINNED_INTEGRITY,
    packages: ["acme::b"],
    nodes: ["acme::b::Bar"],
    resolvedFrom: { path: "../b" },
  };
  const lock: Lock = {
    schema_version: 1,
    dependencies: { "b-dep": entryB, "a-dep": entryA },
  };

  await writeLock(projectRoot, lock);

  const path = join(projectRoot, DEFAULT_METAOBJECTS_DIR, LOCK_FILE);
  const raw = await readFile(path, "utf8");

  // The exact bytes `meta deps sync` would write — asserted against the
  // written TEXT, not the re-parsed object, since the byte-for-byte
  // guarantee (DESIGN §3.3) is about what lands on disk.
  const expected =
    "{\n" +
    '  "schema_version": 1,\n' +
    '  "dependencies": {\n' +
    '    "a-dep": {\n' +
    '      "version": "1.0.0",\n' +
    '      "metamodelVersion": "1.0",\n' +
    '      "artifact": "a.metaobjects.json",\n' +
    `      "integrity": "${PINNED_INTEGRITY}",\n` +
    '      "packages": [\n' +
    '        "acme::a"\n' +
    "      ],\n" +
    '      "nodes": [\n' +
    '        "acme::a::Foo"\n' +
    "      ],\n" +
    '      "resolvedFrom": {\n' +
    '        "path": "../a"\n' +
    "      }\n" +
    "    },\n" +
    '    "b-dep": {\n' +
    '      "version": "2.0.0",\n' +
    '      "metamodelVersion": "1.0",\n' +
    '      "artifact": "b.metaobjects.json",\n' +
    `      "integrity": "${PINNED_INTEGRITY}",\n` +
    '      "packages": [\n' +
    '        "acme::b"\n' +
    "      ],\n" +
    '      "nodes": [\n' +
    '        "acme::b::Bar"\n' +
    "      ],\n" +
    '      "resolvedFrom": {\n' +
    '        "path": "../b"\n' +
    "      }\n" +
    "    }\n" +
    "  }\n" +
    "}\n";
  expect(raw).toBe(expected);

  // Restated as independent, narrower checks so a future format change
  // fails with a pinpointed message rather than only a giant string diff.
  expect(raw.endsWith("\n")).toBe(true);
  expect(raw.endsWith("\n\n")).toBe(false);
  expect(raw.indexOf('"a-dep"')).toBeLessThan(raw.indexOf('"b-dep"'));
  expect(raw).toContain('\n  "dependencies"'); // 2-space indent, level 1
  expect(raw).toContain('\n    "a-dep"'); // level 2
  expect(raw).toContain('\n      "version"'); // level 3
  expect(raw).not.toContain(projectRoot); // no absolute host path leaked in
  expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // no ISO timestamp

  const reloaded = await readLock(projectRoot);
  expect(reloaded).toEqual(lock);
  expect(reloaded && Object.keys(reloaded.dependencies)).toEqual(["a-dep", "b-dep"]);
});
