import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMemory } from "../src/memory.js";
import { sha256Integrity } from "../src/dependencies.js";
import { forgeTypesProvider } from "../src/forge-types.js";
import { rejectedCode } from "./support/error-code.js";

function makeMetaRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-load-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  mkdirSync(join(root, "metaobjects", "_pending"), { recursive: true });
  return root;
}

describe("loadMemory", () => {
  test("loads metadata files from metaobjects/", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "domain.json"),
        JSON.stringify({
          metadata: {
            package: "test",
            children: [
              { object: { name: "User", subType: "entity", children: [] } },
            ],
          },
        }),
      );

      const meta = await loadMemory(root);
      const user = meta.findObject("User");
      expect(user).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes _pending/ subdirectory", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "main.json"),
        JSON.stringify({
          metadata: {
            package: "test",
            children: [
              { object: { name: "Main", subType: "entity", children: [] } },
            ],
          },
        }),
      );
      writeFileSync(
        join(root, "metaobjects", "_pending", "draft.json"),
        JSON.stringify({
          metadata: {
            package: "test::draft",
            children: [
              { object: { name: "Draft", subType: "entity", children: [] } },
            ],
          },
        }),
      );

      const meta = await loadMemory(root);
      const names = meta.ownChildren().map((c) => c.name);
      expect(names).toContain("Main");
      expect(names).not.toContain("Draft");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // C4 — memory.ts's own `isMetadataFile` used to match extensions
  // case-SENSITIVELY while sources.ts's (already fixed to mirror
  // DirectorySource in @metaobjectsdev/metadata) matched case-insensitively.
  // Two metadata-file walkers in one package disagreeing about whether
  // `meta.JSON` counts is exactly the drift this package's design exists to
  // prevent; memory.ts now imports the shared, case-insensitive
  // implementation. This is an intentional BEHAVIOR CHANGE — a file named
  // `*.JSON` (previously silently skipped by loadMemory) is now collected.
  test("collects a metadata file with an uppercase extension (meta.JSON), case-insensitively", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "shouty.JSON"),
        JSON.stringify({
          metadata: {
            package: "test",
            children: [
              { object: { name: "Shouty", subType: "entity", children: [] } },
            ],
          },
        }),
      );

      const meta = await loadMemory(root);
      const shouty = meta.findObject("Shouty");
      expect(shouty).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("decision children need the forge provider OPTED IN — they are not a default", async () => {
    // The forge vocabulary is registered in no port but TypeScript, and in no
    // `expected-registry.json`, so having it in the DEFAULT composition gave one document
    // two verdicts: `@forgeConfidence` loaded here and failed `ERR_UNKNOWN_ATTR` on C#,
    // Python, Java and Kotlin. It is opt-in now, the chartered ADR-0023 way — asserted in
    // BOTH directions, because "no longer default" is only half of what was decided.
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "decisions.json"),
        JSON.stringify({
          metadata: {
            package: "test",
            children: [
              {
                decision: {
                  name: "useTanstackQuery",
                  subType: "global",
                  "@forgeConfidence": 0.9,
                },
              },
            ],
          },
        }),
      );

      // Opted in: the vocabulary works exactly as before.
      const withForge = await loadMemory(root, { providers: [forgeTypesProvider] });
      const dec = withForge.ownChildren().find((c) => c.type === "decision");
      expect(dec).toBeDefined();
      expect(dec!.name).toBe("useTanstackQuery");

      // Default: the type is not registered, so this is not silently ignored — it fails
      // the load, the same way it always has on the other four ports.
      await expect(loadMemory(root)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nothing to resolve is ERR_COLLECTION_NOT_FOUND, the same code every command reports", async () => {
    // `loadMemory` resolves through `resolveCollection` like every other read
    // path, so the "you have no metadata here" failure is that function's
    // structured code rather than a bare `readdir` ENOENT from a directory
    // `loadMemory` picked on its own.
    const root = mkdtempSync(join(tmpdir(), "memory-load-nodir-"));
    try {
      expect(await rejectedCode(loadMemory(root))).toBe("ERR_COLLECTION_NOT_FOUND");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns empty model when metaobjects/ has no metadata files", async () => {
    const root = makeMetaRoot();
    try {
      const meta = await loadMemory(root);
      expect(meta.ownChildren()).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads .yaml metadata files alongside .json", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "json-entity.json"),
        JSON.stringify({
          metadata: {
            package: "test",
            children: [
              { object: { name: "FromJson", subType: "entity", children: [] } },
            ],
          },
        }),
      );
      writeFileSync(
        join(root, "metaobjects", "yaml-entity.yaml"),
        [
          "metadata:",
          "  package: test",
          "  children:",
          "    - object.entity:",
          "        name: FromYaml",
          "        children: []",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "metaobjects", "yml-entity.yml"),
        [
          "metadata:",
          "  package: test",
          "  children:",
          "    - object.entity:",
          "        name: FromYml",
          "        children: []",
          "",
        ].join("\n"),
      );

      const meta = await loadMemory(root);
      const names = meta.ownChildren().map((c) => c.name);
      expect(names).toContain("FromJson");
      expect(names).toContain("FromYaml");
      expect(names).toContain("FromYml");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The `package.meta.json` + workspace `extends:` peer walk is RETIRED (design
// §11; `docs/features/metadata-sources.md` → Upgrading). `loadMemory` had two
// ways of finding metadata, one of them implicit and reachable only from a
// particular repository layout. It now has none of its own: it asks
// `resolveCollection`, exactly like every other read path.
//
// These tests pin what the Upgrading section PROMISES about that removal —
// that it fails loudly, and that a declared source replaces it — rather than
// merely deleting the coverage along with the feature.
describe("loadMemory — the retired workspace peer walk", () => {
  test("a declared source is the replacement, and it needs no topological order", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-loadmem-"));
    try {
      // Workspace setup: shared package + billing package that extends shared
      writeFileSync(join(wsRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

      // shared package: defines a User entity
      mkdirSync(join(wsRoot, "packages", "shared", ".meta"), { recursive: true });
      mkdirSync(join(wsRoot, "packages", "shared", "metaobjects"), { recursive: true });
      writeFileSync(
        join(wsRoot, "packages", "shared", ".meta", "package.meta.json"),
        JSON.stringify({
          name: "@acme/shared",
          version: "1.0.0",
          metaobjectsPackage: "acme::shared",
          extends: [],
        }),
      );
      writeFileSync(
        join(wsRoot, "packages", "shared", "metaobjects", "shared.json"),
        JSON.stringify({
          metadata: {
            package: "acme::shared",
            children: [
              { object: { name: "User", subType: "entity", children: [] } },
            ],
          },
        }),
      );

      // billing package: reaches shared by DECLARING it as a source. The
      // shared entry is written SECOND on purpose — `sources` is a set, so
      // there is no topological order to reproduce.
      mkdirSync(join(wsRoot, "packages", "billing", ".metaobjects"), { recursive: true });
      mkdirSync(join(wsRoot, "packages", "billing", "metaobjects"), { recursive: true });
      writeFileSync(
        join(wsRoot, "packages", "billing", ".metaobjects", "config.json"),
        JSON.stringify({
          schema_version: 1,
          sources: [{ path: "metaobjects" }, { path: "../shared/metaobjects" }],
        }),
      );
      writeFileSync(
        join(wsRoot, "packages", "billing", "metaobjects", "billing.json"),
        JSON.stringify({
          metadata: {
            package: "acme::billing",
            children: [
              { object: { name: "Invoice", subType: "entity", children: [] } },
            ],
          },
        }),
      );

      // Load from billing's perspective
      const meta = await loadMemory(join(wsRoot, "packages", "billing"));
      const childNames = meta.ownChildren().map((c) => c.name).sort();
      // Both packages' entities are loaded into the merged MetaData tree
      expect(childNames).toContain("User");
      expect(childNames).toContain("Invoice");
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  test("a project declaring nothing resolves its own default source, and only that", async () => {
    // The other side of the removal: with no config and no peer walk, the
    // default source is the whole of what loads.
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "myapp.json"),
        JSON.stringify({
          metadata: {
            package: "myapp",
            children: [
              { object: { name: "Only", subType: "entity", children: [] } },
            ],
          },
        }),
      );
      const meta = await loadMemory(root);
      expect(meta.ownChildren().map((c) => c.name)).toEqual(["Only"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a model that leaned on the peer walk fails LOUDLY, with ERR_UNRESOLVED_SUPER", async () => {
    // The Upgrading section's promise, gated: nothing generates from a
    // half-resolved model. `domain` declares no `sources`, so it resolves its
    // own default directory and nothing else — and the `extends:` into
    // `acme::common` that the workspace walk used to satisfy now names a target
    // no loaded file declares.
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-crossref-"));
    try {
      writeFileSync(join(wsRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

      // common: declares an abstract id field
      mkdirSync(join(wsRoot, "packages", "common", ".meta"), { recursive: true });
      mkdirSync(join(wsRoot, "packages", "common", "metaobjects"), { recursive: true });
      writeFileSync(
        join(wsRoot, "packages", "common", ".meta", "package.meta.json"),
        JSON.stringify({
          name: "@acme/common",
          version: "1.0.0",
          metaobjectsPackage: "acme::common",
          extends: [],
        }),
      );
      writeFileSync(
        join(wsRoot, "packages", "common", "metaobjects", "common.json"),
        JSON.stringify({
          "metadata.root": {
            package: "acme::common",
            children: [
              { "field.long": { name: "id", abstract: true } },
            ],
          },
        }),
      );

      // domain: extends common; uses super: to inherit common::id
      mkdirSync(join(wsRoot, "packages", "domain", ".meta"), { recursive: true });
      mkdirSync(join(wsRoot, "packages", "domain", "metaobjects"), { recursive: true });
      writeFileSync(
        join(wsRoot, "packages", "domain", ".meta", "package.meta.json"),
        JSON.stringify({
          name: "@acme/domain",
          version: "1.0.0",
          metaobjectsPackage: "acme::domain",
          extends: ["@acme/common"],
        }),
      );
      writeFileSync(
        join(wsRoot, "packages", "domain", "metaobjects", "domain.json"),
        JSON.stringify({
          "metadata.root": {
            package: "acme::domain",
            children: [
              {
                "object.entity": {
                  name: "Widget",
                  children: [
                    // `field.long`, not a bare `field`: `field` declares no default subType,
                    // so a bare key would now fail as ERR_MISSING_SUBTYPE and mask the
                    // ERR_UNRESOLVED_SUPER this test is actually about.
                    { "field.long": { name: "id", extends: "acme::common::id" } },
                  ],
                },
              },
            ],
          },
        }),
      );

      expect(await rejectedCode(loadMemory(join(wsRoot, "packages", "domain")))).toBe(
        "ERR_UNRESOLVED_SUPER",
      );
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});

describe("loadMemory with an explicit file set", () => {
  test("loads exactly the supplied files, ignoring any metaobjects/ dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metaobjects-memory-files-"));
    try {
      mkdirSync(join(dir, "model"), { recursive: true });
      mkdirSync(join(dir, "metaobjects"), { recursive: true });
      writeFileSync(join(dir, "model/meta.a.json"), JSON.stringify({
        "metadata.root": { package: "acme", children: [
          { "object.entity": { name: "Order", children: [{ "field.string": { name: "id" } }] } }] },
      }), "utf8");
      writeFileSync(join(dir, "metaobjects/meta.decoy.json"), JSON.stringify({
        "metadata.root": { package: "acme", children: [
          { "object.entity": { name: "Decoy", children: [{ "field.string": { name: "id" } }] } }] },
      }), "utf8");
      const root = await loadMemory(dir, { files: [join(dir, "model/meta.a.json")] });
      const names = root.children().map((c) => c.name);
      expect(names).toContain("Order");
      expect(names).not.toContain("Decoy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no `files` option, a project with a metaobjects/ tree still loads exactly as before", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "domain.json"),
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [
              { "object.entity": { name: "Order", children: [{ "field.string": { name: "id" } }] } },
            ],
          },
        }),
        "utf8",
      );

      const meta = await loadMemory(root);
      const names = meta.children().map((c) => c.name);
      expect(names).toEqual(["Order"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// FR-023 Task 8 — `fileIds` is how a dependency's artifact keeps its identity
// through the load: the snapshot is a file on the consumer's disk, so its default
// source id would be the artifact's basename and every diagnostic about it would
// read like a local file. The collection maps its path to `dep:<name>/<artifact>`
// and `loadMemory` builds the FileSource with that id, so the provenance stamped
// on every node the artifact contributed (ADR-0009) names the DEPENDENCY.
describe("loadMemory with fileIds (FR-023)", () => {
  const nodeSourceFile = (node: { source: unknown }): string | undefined => {
    const src = node.source;
    if (typeof src !== "object" || src === null || !("files" in src)) return undefined;
    const files = (src as { files: readonly string[] }).files;
    return files[0];
  };

  test("a mapped path loads under that id; an unmapped one keeps the basename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metaobjects-memory-fileids-"));
    try {
      mkdirSync(join(dir, "model"), { recursive: true });
      const file = join(dir, "model/acme-common.metaobjects.json");
      writeFileSync(file, JSON.stringify({
        "metadata.root": { children: [
          { "object.entity": { name: "Customer", package: "acme::common", children: [
            { "field.string": { name: "email" } }] } }] },
      }), "utf8");

      const id = "dep:acme-common/acme-common.metaobjects.json";
      const withIds = await loadMemory(dir, { files: [file], fileIds: new Map([[file, id]]) });
      const customer = withIds.children().find((c) => c.name === "Customer");
      expect(customer).toBeDefined();
      expect(nodeSourceFile(customer!)).toBe(id);

      // Same file, no map — the default basename, exactly as before FR-023.
      const plain = await loadMemory(dir, { files: [file] });
      expect(nodeSourceFile(plain.children().find((c) => c.name === "Customer")!)).toBe(
        "acme-common.metaobjects.json",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// FR-023 — `loadMemory` has TWO arms, and the ownership refusal has to fire on
// BOTH. The routed CLI commands take the first (they hold a collection already
// and pass it through `collectionLoadOptions`); an embedder that calls
// `loadMemory(repoRoot)` with no `files` takes the second, where this function
// resolves the collection itself. Wired into the first arm only, the refusal
// would be silently absent for every such embedder — and the shared corpus
// cannot catch that, because its runner always passes a file list.
describe("loadMemory — the self-resolving arm reads dependencies too (FR-023)", () => {
  const ARTIFACTS = resolve(import.meta.dir, "../../../../../fixtures/dependency-conformance/artifacts");
  const ARTIFACT = "acme-common.metaobjects.json";

  /** A consumer of `acme-common`, optionally with a local file of its own. */
  function consumer(local?: { readonly name: string; readonly body: string }): string {
    const dir = mkdtempSync(join(tmpdir(), "metaobjects-memory-deps-"));
    const text = readFileSync(join(ARTIFACTS, "acme-common-v1.json"), "utf8");
    mkdirSync(join(dir, ".metaobjects/deps/acme-common"), { recursive: true });
    writeFileSync(join(dir, ".metaobjects/deps/acme-common", ARTIFACT), text, "utf8");
    mkdirSync(join(dir, "metaobjects"), { recursive: true });
    writeFileSync(join(dir, ".metaobjects/config.json"), JSON.stringify({
      schema_version: 1,
      sources: [],
      dependencies: [{ name: "acme-common", path: "../acme-common/metaobjects" }],
    }), "utf8");
    writeFileSync(join(dir, ".metaobjects/deps.lock.json"), JSON.stringify({
      schema_version: 1,
      dependencies: { "acme-common": {
        version: "1.0.0",
        metamodelVersion: "1.0",
        resolvedFrom: { path: "../acme-common/metaobjects" },
        artifact: ARTIFACT,
        integrity: sha256Integrity(text),
        packages: ["acme::common"],
        nodes: ["acme::common::Address", "acme::common::Audited", "acme::common::Customer"],
      } },
    }), "utf8");
    if (local !== undefined) writeFileSync(join(dir, "metaobjects", local.name), local.body, "utf8");
    return dir;
  }

  test("the artifact loads under its dep: id with no `files` option", async () => {
    const dir = consumer({ name: "meta.app.json", body: JSON.stringify({
      "metadata.root": { package: "app", children: [
        { "object.entity": { name: "Order", children: [{ "field.string": { name: "id" } }] } }] },
    }) });
    try {
      const root = await loadMemory(dir);
      const customer = root.children().find((c) => c.name === "Customer");
      expect(customer).toBeDefined();
      const src = customer!.source;
      expect("files" in src ? (src as { files: readonly string[] }).files[0] : undefined).toBe(
        `dep:acme-common/${ARTIFACT}`,
      );
      // The project's own file still loads, and keeps its own basename.
      expect(root.children().map((c) => c.name)).toContain("Order");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a local node in the dependency's package is refused on this arm too", async () => {
    const dir = consumer({ name: "meta.ext.json", body: JSON.stringify({
      "metadata.root": { package: "acme::common", children: [
        { "object.value": { name: "Note", children: [{ "field.string": { name: "text" } }] } }] },
    }) });
    try {
      expect(await rejectedCode(loadMemory(dir))).toBe("ERR_DEPENDENCY_PACKAGE_NOT_OWNED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an OVERLAY of the dependency's own node is not refused", async () => {
    // The distinction the refusal turns on: this node's resolution key IS in the
    // lock's `nodes`, so it merged into the imported Customer rather than
    // declaring a new one.
    const dir = consumer({ name: "meta.ov.json", body: JSON.stringify({
      "metadata.root": { package: "acme::common", children: [
        { "object.entity": { name: "Customer", overlay: true, children: [
          { "field.string": { name: "nickname" } }] } }] },
    }) });
    try {
      const root = await loadMemory(dir);
      const customer = root.children().find((c) => c.name === "Customer");
      expect(customer?.children().map((c) => c.name)).toContain("nickname");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
