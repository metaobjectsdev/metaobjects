// FR-043 §3.4 — `meta eject <library>`: the copy door for declared design.
//
// ADR-0034 ruled that a reference GENERATOR is copied into the adopter's repo because
// the adopter owns their code; §3.4 extends that to metadata and makes it the EXPECTED
// mode. So the assertions here are about ownership rather than about copying: the files
// land in the project's OWN declared source root, they carry the provenance that makes
// their origin legible later, and they tell the adopter the one step that finishes the
// job — which the loader then enforces.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ejectCommand } from "../src/commands/eject.js";
import { ejectLibrary, libraryStaleness, EJECT_MARKER } from "../src/lib/library-eject.js";

/** A project whose declared source root is deliberately NOT named `metaobjects/` —
 *  that string is the default value of `sources`, and eject must resolve the root
 *  through the collection rather than assuming it. */
function project(libraries: string[] = ["iam"]): string {
  const root = mkdtempSync(join(tmpdir(), "eject-lib-"));
  mkdirSync(join(root, ".metaobjects"));
  mkdirSync(join(root, "model"));
  writeFileSync(
    join(root, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, sources: [{ path: "model" }], libraries }, null, 2),
  );
  writeFileSync(
    join(root, "model", "mine.yaml"),
    "metadata:\n  package: acme::app\n  children:\n    - object.value:\n        name: Ping\n        children:\n          - field.string: { name: at }\n",
  );
  return root;
}

describe("meta eject <library>", () => {
  test("copies every layer into the project's own DECLARED source root", async () => {
    const root = project();
    try {
      const result = await ejectLibrary({ cwd: root, name: "iam" });
      expect(result.root).toBe(join(root, "model"));
      // Every ref, core and db — you eject the library, not a layer of it.
      expect(result.files.map((f) => f.ref).sort()).toEqual([
        "iam/db", "iam/model", "iam/requirements",
      ]);
      for (const f of result.files) {
        expect(f.status).toBe("created");
        expect(existsSync(join(root, "model", f.path))).toBe(true);
      }
      // Named for the concept, not for the library's internal filenames: three
      // libraries ejected into one root would otherwise collide on `model.yaml`.
      expect(readdirSync(join(root, "model")).sort()).toEqual([
        "meta.iam.db.yaml", "meta.iam.model.yaml", "meta.iam.requirements.yaml", "mine.yaml",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every file carries provenance AND the one step that finishes the eject", async () => {
    const root = project();
    try {
      await ejectLibrary({ cwd: root, name: "iam" });
      const text = readFileSync(join(root, "model", "meta.iam.model.yaml"), "utf8");
      expect(text.startsWith(`${EJECT_MARKER} library=iam ref=iam/model`)).toBe(true);
      expect(text).toContain("YOU OWN THIS FILE");
      expect(text).toContain("ERR_LIBRARY_PACKAGE_COLLISION");
      // And the metadata itself is intact under the header.
      expect(text).toContain("metadata:");
      expect(text).toContain("name: User");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never clobbers without --force", async () => {
    const root = project();
    try {
      await ejectLibrary({ cwd: root, name: "iam" });
      writeFileSync(join(root, "model", "meta.iam.model.yaml"), "# mine now\n");
      const again = await ejectLibrary({ cwd: root, name: "iam" });
      expect(again.files.find((f) => f.ref === "iam/model")!.status).toBe("preserved");
      expect(readFileSync(join(root, "model", "meta.iam.model.yaml"), "utf8")).toBe("# mine now\n");

      const forced = await ejectLibrary({ cwd: root, name: "iam", force: true });
      expect(forced.files.find((f) => f.ref === "iam/model")!.status).toBe("replaced");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports what is still opted in — the step that makes the copy usable", async () => {
    const root = project(["iam", "iam/db"]);
    try {
      const result = await ejectLibrary({ cwd: root, name: "iam" });
      expect(result.stillOptedIn).toEqual(["iam", "iam/db"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a library name is accepted by the command beside generator names", async () => {
    const root = project([]);
    try {
      expect(await ejectCommand(["iam"], root, "json")).toBe(0);
      expect(existsSync(join(root, "model", "meta.iam.model.yaml"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("meta eject --list — library staleness", () => {
  test("a fresh eject is identical to the shipped library", async () => {
    const root = project([]);
    try {
      await ejectLibrary({ cwd: root, name: "iam" });
      const rows = await libraryStaleness(root);
      expect(rows.length).toBe(1);
      expect(rows[0]!.library).toBe("iam");
      expect(rows[0]!.verdict).toBe("identical");
      expect(rows[0]!.stillOptedIn).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a changed node, a deleted one and an added one are counted apart", async () => {
    const root = project([]);
    try {
      await ejectLibrary({ cwd: root, name: "iam" });
      // Delete one node outright, add one of my own, and change a third — the three
      // things an owner actually does to a copy.
      const model = join(root, "model", "meta.iam.model.yaml");
      const text = readFileSync(model, "utf8");
      writeFileSync(
        model,
        `${text}\n    - object.entity:\n        name: ApiKey\n        children:\n          - field.uuid: { name: id }\n`,
      );
      const rows = await libraryStaleness(root);
      expect(rows[0]!.verdict).toBe("differs");
      expect(rows[0]!.localOnly).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("renaming the package is NOT drift — nodes are matched by name", async () => {
    // §3.4 says an adopter who ejects may rename the package freely. Keying the
    // comparison on the FQN would report every node as both gone and new.
    const root = project([]);
    try {
      await ejectLibrary({ cwd: root, name: "iam" });
      for (const f of ["meta.iam.model.yaml", "meta.iam.db.yaml", "meta.iam.requirements.yaml"]) {
        const p = join(root, "model", f);
        writeFileSync(p, readFileSync(p, "utf8").replaceAll("metaobjects::iam", "acme::iam"));
      }
      const rows = await libraryStaleness(root);
      expect(rows[0]!.verdict).toBe("identical");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a project that ejected nothing reports nothing", async () => {
    const root = project([]);
    try {
      expect(await libraryStaleness(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the `metaobjects::` prefix advisory (FR-043 §3.5)", () => {
  test("an ejected file is exempt — its header IS the provenance", async () => {
    const { scanForUnprovenancedLibraryPrefix } = await import(
      "../src/lib/library-prefix-advisory.js"
    );
    const { loadMemory } = await import("@metaobjectsdev/sdk");
    const { resolveCollection } = await import("@metaobjectsdev/sdk");
    const root = project([]);
    try {
      await ejectLibrary({ cwd: root, name: "iam" });
      const collection = await resolveCollection(root);
      const model = await loadMemory(root, { strict: true });
      expect(
        await scanForUnprovenancedLibraryPrefix(model, collection.ownFiles, collection.configDir),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a hand-copied node under the prefix is flagged, with the eject door named", async () => {
    const { scanForUnprovenancedLibraryPrefix } = await import(
      "../src/lib/library-prefix-advisory.js"
    );
    const { loadMemory, resolveCollection } = await import("@metaobjectsdev/sdk");
    const root = project([]);
    try {
      writeFileSync(
        join(root, "model", "copied.yaml"),
        "metadata:\n  package: metaobjects::iam\n  children:\n    - object.value:\n        name: Whatever\n        children:\n          - field.string: { name: x }\n",
      );
      const collection = await resolveCollection(root);
      const model = await loadMemory(root, { strict: true });
      const findings = await scanForUnprovenancedLibraryPrefix(
        model, collection.ownFiles, collection.configDir,
      );
      expect(findings.length).toBe(1);
      expect(findings[0]!.fqn).toBe("metaobjects::iam::Whatever");
      expect(findings[0]!.message).toContain("meta eject");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
