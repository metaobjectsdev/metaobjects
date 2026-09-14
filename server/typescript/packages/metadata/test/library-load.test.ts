import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  librarySources,
  knownLibraryPackages,
  knownLibraryTokens,
  libraryManifests,
  splitLayerToken,
} from "../src/library/library-sources.js";
import { MetaDataLoader } from "../src/index.js";

async function textOf(sources: readonly { read: () => Promise<string> }[]): Promise<string> {
  return (await Promise.all(sources.map((s) => s.read()))).join("\n");
}

describe("librarySources — layer selection (FR-043 Amendment 1)", () => {
  test("a bare library name resolves its CORE layer only", async () => {
    const sources = librarySources(["ai"]);
    const text = await textOf(sources);
    expect(text).toContain("LlmCallBase");
    // The core layer is SOURCELESS — that is the whole point of the split. A bare name
    // must not drag the db layer in, or opting into a design would propose tables.
    expect(text).not.toContain("table: llm_call");
  });

  test("a layer token adds that layer AND implies the core", async () => {
    const text = await textOf(librarySources(["ai/db"]));
    // The core comes too: a db layer is nothing but `overlay: true` redeclarations, and
    // an overlay whose target was never declared is ERR_OVERLAY_NO_TARGET. Implying the
    // core is the only coherent reading, not a convenience.
    expect(text).toContain("LlmCallBase");
    expect(text).toContain("table: llm_call");
  });

  test("naming both the core and a layer resolves each ref ONCE", async () => {
    const both = librarySources(["ai", "ai/db"]);
    const layerOnly = librarySources(["ai/db"]);
    expect(both.length).toBe(layerOnly.length);
  });

  test("the core is ordered BEFORE its layers, however the tokens are written", async () => {
    const sources = librarySources(["ai/db", "ai"]);
    const first = await sources[0]!.read();
    // ADR-0055 applies overlays in a deferred pass, so this is belt rather than brace —
    // but a base parsed after its overlay is the shape #160's retired partition existed
    // to work around, and there is no reason to reintroduce the ordering question.
    expect(first).toContain("LlmCallBase");
  });

  test("an unknown library, and an unknown LAYER of a known library, yield no sources", () => {
    expect(librarySources(["does-not-exist"]).length).toBe(0);
    expect(librarySources(["ai/does-not-exist"]).length).toBe(0);
  });

  test("splitLayerToken splits on the FIRST separator only", () => {
    expect(splitLayerToken("iam")).toEqual(["iam", ""]);
    expect(splitLayerToken("iam/db")).toEqual(["iam", "db"]);
    // Not a prefix match: a typo stays a typo rather than resolving to something.
    expect(splitLayerToken("iam/db/extra")).toEqual(["iam", "db/extra"]);
  });
});

describe("library manifests", () => {
  test("every shipped library has a manifest, and the names agree", () => {
    const manifests = libraryManifests();
    expect(knownLibraryPackages()).toEqual(Object.keys(manifests).sort());
    for (const [name, m] of Object.entries(manifests)) {
      // `name` is RESOLVED against the key, and both against the last package segment —
      // a manifest that names itself differently from its directory would resolve
      // layers under one name and packages under another.
      expect(m.name, `${name}.name`).toBe(name);
      for (const pkg of m.packages ?? []) {
        expect(pkg.split("::").pop(), `${name} package ${pkg}`).toBe(name);
      }
    }
  });

  test("every layer's refs are really embedded", async () => {
    for (const [name, m] of Object.entries(libraryManifests())) {
      for (const [layer, spec] of Object.entries(m.layers ?? {})) {
        const token = layer === "" ? name : `${name}/${layer}`;
        const sources = librarySources([token]);
        // A ref the manifest declares but the embed does not carry makes
        // `librarySources` throw; getting here at all is the assertion.
        expect(sources.length, `${token} resolves`).toBeGreaterThan(0);
        expect(spec.refs.length, `${token} declares refs`).toBeGreaterThan(0);
      }
    }
  });

  test("knownLibraryTokens lists every library AND every layer", () => {
    const tokens = knownLibraryTokens();
    // What a config error prints. Listing only library names would show an adopter who
    // typed `iam/database` nothing about the layer they meant.
    expect(tokens).toContain("ai");
    expect(tokens).toContain("ai/db");
    expect(tokens).toContain("iam");
    expect(tokens).toContain("iam/db");
    expect([...tokens].sort()).toEqual(tokens);
  });
});

describe("the CORE layer of every shipped library is INERT", () => {
  test("no core layer declares a source, in any library", async () => {
    // FR-043 §8 item 2b — the inertness promise, RESOLVED rather than trusted.
    //
    // A sourceless object generates nothing and migrates to nothing (migrate skips an
    // object with no writable source; codegen emits no route, queries, hooks, grid or
    // form for one, both citing #248). That is what makes `libraries: ["iam"]` add zero
    // tables. A single `source.rdb` slipped into a core layer breaks it SILENTLY — the
    // adopter's next `meta migrate` simply proposes a table.
    for (const name of knownLibraryPackages()) {
      const result = await new MetaDataLoader({ strict: true }).load(librarySources([name]));
      expect(result.errors, `${name} core loads clean`).toEqual([]);
      const sourced = result.root
        .objects()
        .filter((o) => o.children().some((c) => c.type === "source"))
        .map((o) => o.name);
      expect(sourced, `${name} core declares no source`).toEqual([]);
    }
  });

  test("...and the db layer is what adds them", async () => {
    // The inverse, so the test above cannot pass by the library shipping nothing at all.
    const result = await new MetaDataLoader({ strict: true }).load(librarySources(["iam/db"]));
    expect(result.errors).toEqual([]);
    const sourced = result.root
      .objects()
      .filter((o) => o.children().some((c) => c.type === "source"))
      .map((o) => o.name)
      .sort();
    expect(sourced).toEqual([
      "Group", "GroupMember", "GroupMemberRole", "GroupType",
      "Permission", "Role", "RolePermission", "User", "UserRole",
    ]);
  });
});

// ---------------------------------------------------------------------------
// App YAML: one concrete entity that extends the library-shipped abstract base.
// Needs identity.primary to avoid WARN_LEGACY (entity without primary identity).
// ---------------------------------------------------------------------------
const APP_YAML = [
  "metadata:",
  "  package: app::ops",
  "  children:",
  "    - object.entity:",
  "        name: ApiCall",
  "        extends: metaobjects::ai::LlmCallBase",
  "        children:",
  "          - source.rdb: { table: api_call, role: primary }",
  '          - identity.primary: { name: id, fields: ["spanId"] }',
].join("\n");

describe("loader libraries option", () => {
  test("app entity extends a library-shipped abstract base", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-libload-"));
    writeFileSync(join(dir, "meta.app.yaml"), APP_YAML);
    const result = await MetaDataLoader.fromDirectory(dir, { libraries: ["ai"] });
    rmSync(dir, { recursive: true, force: true });

    expect(result.errors).toEqual([]);
    const apiCall = result.root.objects().find((o) => o.name === "ApiCall");
    expect(apiCall).toBeDefined();
    expect(apiCall!.fields().some((f) => f.name === "llmRequest")).toBe(true);
  });

  test("without the libraries option, the same extends is unresolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-libload-no-"));
    writeFileSync(join(dir, "meta.app.yaml"), APP_YAML);
    const result = await MetaDataLoader.fromDirectory(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(result.errors.some((e) => (e as { code?: string }).code === "ERR_UNRESOLVED_SUPER")).toBe(true);
  });
});
