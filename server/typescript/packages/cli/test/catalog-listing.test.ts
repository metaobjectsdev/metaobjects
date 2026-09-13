// `meta gen --list` — the catalog, and `--probe`, the half that runs the generators.
//
// Two separate claims, kept apart because they fail for different reasons:
//   - the LISTING describes the installed engine and needs no project at all;
//   - the PROBE answers "what would this emit for MY model" by dry-running every
//     catalog generator, so it needs one and says so when there isn't one.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";
import { genCommand } from "../src/commands/gen.js";
import {
  buildCatalogListing, wiredGeneratorNames,
  type GeneratorCatalogRow, type LibraryCatalogRow,
} from "../src/lib/catalog-listing.js";
import { composeCatalog } from "../src/lib/catalog.js";

const FIXTURE = join(import.meta.dir, "fixtures", "catalog-probe");

let logged: string[];
let erred: string[];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logged = [];
  erred = [];
  console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { erred.push(a.join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

const baseConfig: MetaobjectsGenConfig = {
  outDir: "src/generated",
  extStyle: "js",
  dialect: "sqlite",
  // `routes` reads this — it emits `import { db } from …` and needs the module to
  // import from. It is a declared `configKey` on that entry precisely so a selection
  // knows to set it; the probe is where an adopter finds out they have not.
  dbImport: "../db",
  generators: [],
};

async function allProbeRows(config: MetaobjectsGenConfig = baseConfig, libraries: string[] = []) {
  const metadata = await loadMemory(FIXTURE, { libraries });
  const tmp = mkdtempSync(join(tmpdir(), "catalog-probe-"));
  try {
    return await buildCatalogListing({
      project: {
        projectRoot: tmp,
        config,
        wiredNames: wiredGeneratorNames(config),
        ownedNames: new Set(),
        declaredDeps: undefined,
        libraries,
      },
      probe: { metadata },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The GENERATOR rows alone — the catalog is one table with two kinds in it since
 *  FR-043, and every assertion below is about the generator half. */
async function probeRows(config: MetaobjectsGenConfig = baseConfig) {
  return (await allProbeRows(config)).filter((r): r is GeneratorCatalogRow => r.kind === "generator");
}

describe("meta gen --list — the catalog", () => {
  test("--format json emits ONE document and every row is well-formed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "meta-catalog-"));
    try {
      const code = await genCommand(["--list"], tmp, "json");
      expect(code).toBe(0);
      const rows = JSON.parse(logged.join("\n")) as Array<Record<string, unknown>>;
      const generators = rows.filter((r) => r.kind === "generator");
      const libraries = rows.filter((r) => r.kind === "library");
      // ONE table, two kinds (FR-043 §4) — and nothing else in it.
      expect(generators.length + libraries.length).toBe(rows.length);
      expect(generators.length).toBe(Object.keys(composeCatalog()).length);
      expect(libraries.length).toBeGreaterThan(0);
      for (const r of generators) {
        expect(typeof r.layer, String(r.name)).toBe("string");
        expect(String(r.package), String(r.name)).toStartWith("@metaobjectsdev/");
        expect(typeof r.description, String(r.name)).toBe("string");
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("needs no project at all — an empty directory is not an error", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "meta-catalog-"));
    try {
      expect(await genCommand(["--list"], tmp, "json")).toBe(0);
      expect(erred.join("\n")).not.toContain("not found");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an ejectable entry carries the facets from its own reference-template header", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "meta-catalog-"));
    try {
      await genCommand(["--list"], tmp, "json");
      const rows = JSON.parse(logged.join("\n")) as Array<Record<string, unknown>>;
      const entity = rows.find((r) => r.name === "entity")!;
      // Read from the template, never restated in the registry — so the row cannot
      // describe the generator differently from the file an adopter opens.
      expect(String(entity.useWhen)).toContain("entity-module generator");
      expect(String(entity.emits)).toContain("<Entity>.ts");
      expect((entity.source as Record<string, unknown>).ejectable).toBe(true);

      // A package-only entry has no template to read, and says so rather than
      // inventing a summary.
      const template = rows.find((r) => r.name === "template")!;
      expect(template.useWhen).toBeUndefined();
      expect((template.source as Record<string, unknown>).kind).toBe("package-only");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--probe without a project is a usage error, not a listing of zeros", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "meta-catalog-"));
    try {
      expect(await genCommand(["--list", "--probe"], tmp, "json")).toBe(2);
      expect(erred.join("\n")).toContain("--probe");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--probe without --list is refused rather than silently ignored", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "meta-catalog-"));
    try {
      expect(await genCommand(["--probe"], tmp, "text")).toBe(2);
      expect(erred.join("\n")).toContain("only meaningful with --list");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("--probe — what would this emit for MY model", () => {
  test("reports a real count for the generators this model asks for", async () => {
    const rows = await probeRows();
    const by = (n: string) => rows.find((r) => r.name === n)!.project!;

    // Two concrete sourced entities (+ the shared enums module the entity generator
    // emits once) — the exact number is the engine's business; that it is non-zero and
    // came from RUNNING the generator is this gate's.
    expect(by("entity").wouldEmit).toBeGreaterThan(0);
    expect(by("queries").wouldEmit).toBeGreaterThan(0);
    expect(by("routes").wouldEmit).toBeGreaterThan(0);

    // The capability tier, which is the whole reason --probe exists: these are not
    // chosen by browsing a taxonomy, they are chosen because the model declared them.
    expect(by("output-parser").wouldEmit).toBeGreaterThan(0);   // a responding template.prompt
    expect(by("output-prompt").wouldEmit).toBeGreaterThan(0);   // ...and its format fragment
    expect(by("prompt-render").wouldEmit).toBeGreaterThan(0);   // ...and its render helper
    expect(by("callable").wouldEmit).toBeGreaterThan(0);        // a storedProc projection
    expect(by("requirement-tests").wouldEmit).toBeGreaterThan(0); // a requirement.functional

    // The client tier keys off a declared layout.dataGrid.
    expect(by("grid").wouldEmit).toBeGreaterThan(0);
  });

  test("a count of ZERO is a real answer, not a failure", async () => {
    const rows = await probeRows();
    // No entity in this model extends LlmCallBase, so the trace helper genuinely has
    // nothing to emit. Zero with no probeError is the honest report, and it is the
    // signal an agent uses to leave the generator unwired.
    const trace = rows.find((r) => r.name === "trace-helper")!.project!;
    expect(trace.wouldEmit).toBe(0);
    expect(trace.probeError).toBeUndefined();
  });

  test("every generator is probed — none is silently skipped", async () => {
    const rows = await probeRows();
    for (const r of rows) {
      const p = r.project!;
      const answered = typeof p.wouldEmit === "number" || typeof p.probeError === "string";
      expect(answered, `${r.name} reported neither a count nor a reason`).toBe(true);
    }
  });

  test("a generator that cannot be probed reports WHY, and leaves the rest intact", async () => {
    // Two shipped generators genuinely cannot run from a bare `--probe`:
    // `render-helper` needs an on-disk template root for its drift gate, and
    // `shared-model` needs a `files` selection `meta gen` supplies at run time. Both
    // report their own message. This is the whole reason each generator gets its own
    // isolated dry-run rather than one run over the suite — a suite-wide run would
    // take the entire listing down with them.
    const rows = await probeRows();
    for (const name of ["render-helper", "shared-model"]) {
      const p = rows.find((r) => r.name === name)!.project!;
      expect(p.wouldEmit, `${name} should not report a count`).toBeNull();
      expect(String(p.probeError), `${name} should say why`).toContain(name);
    }
    // ...and everything else still answered.
    expect(rows.filter((r) => typeof r.project!.wouldEmit === "number").length)
      .toBeGreaterThan(rows.length - 4);
  });

  test("a config that omits a generator's configKey shows up as that generator's probeError", async () => {
    // The catalog says `routes` reads `dbImport`. Dropping it must surface on the
    // ROUTES row and nowhere else — that is what makes the probe an answer to "can I
    // turn this on" rather than a yes/no about the whole project.
    const { dbImport: _omitted, ...withoutDbImport } = baseConfig;
    const rows = await probeRows(withoutDbImport);
    const routes = rows.find((r) => r.name === "routes")!.project!;
    expect(routes.wouldEmit).toBeNull();
    expect(String(routes.probeError)).toContain("dbImport");
    expect(rows.find((r) => r.name === "entity")!.project!.wouldEmit).toBeGreaterThan(0);
  });

  test("`wired` reflects the config's own generator list", async () => {
    const rows = await probeRows();
    expect(rows.find((r) => r.name === "entity")!.project!.wired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR-043 §4 — the library rows
// ---------------------------------------------------------------------------

async function libraryRows(libraries: string[] = []): Promise<LibraryCatalogRow[]> {
  return (await allProbeRows(baseConfig, libraries)).filter(
    (r): r is LibraryCatalogRow => r.kind === "library",
  );
}

describe("meta gen --list — the library rows", () => {
  test("a library describes what is IN THE BOX, across every layer", async () => {
    const iam = (await libraryRows()).find((r) => r.name === "iam")!;
    expect(iam.libraryKind).toBe("feature");
    expect(iam.stability).toBe("preview");
    expect(iam.packages).toEqual(["metaobjects::iam"]);
    // `provides` is the whole library, not the selection — an adopter reading it is
    // deciding whether to opt in at all.
    expect(iam.provides.entities).toBe(9);
    expect(iam.provides.abstracts).toBeGreaterThan(0);
    expect(iam.provides.requirements).toBeGreaterThan(0);
    // The layer tokens are the field an adopter ACTS on: under Amendment 1 you do not
    // opt into a library, you opt into its layers.
    expect(iam.layers.map((l) => l.token)).toEqual(["iam", "iam/db"]);
    expect(iam.ports).toContain("java");
  });

  test("not opted in: the project block says so without pretending to measure", async () => {
    const iam = (await libraryRows([])).find((r) => r.name === "iam")!;
    expect(iam.project!.optedIn).toBe(false);
    expect(iam.project!.selectedLayers).toEqual([]);
    // Probed, with no library in the model: nothing extends it, nothing was added.
    expect(iam.project!.tablesAdded).toBe(0);
    expect(iam.project!.requirementsAdded).toBe(0);
    expect(iam.project!.extendedBy).toEqual([]);
  });

  test("the CORE layer adds requirements and NO tables — the inertness promise, as a number", async () => {
    const iam = (await libraryRows(["iam"])).find((r) => r.name === "iam")!;
    expect(iam.project!.optedIn).toBe(true);
    expect(iam.project!.selectedLayers).toEqual(["iam"]);
    expect(iam.project!.tablesAdded).toBe(0);
    expect(iam.project!.requirementsAdded).toBe(iam.provides.requirements);
  });

  test("...and the db layer is what puts tables on the table", async () => {
    const iam = (await libraryRows(["iam", "iam/db"])).find((r) => r.name === "iam")!;
    expect(iam.project!.selectedLayers).toEqual(["iam", "iam/db"]);
    expect(iam.project!.tablesAdded).toBe(9);
  });

  test("an implied generator nobody wired is reported, not enforced", async () => {
    // `ai` declares `trace-helper`; the fixture config wires nothing. A library is
    // metadata — wiring the generator it implies stays the adopter's call, so this is
    // a fact on the row rather than a warning here.
    const ai = (await libraryRows(["ai"])).find((r) => r.name === "ai")!;
    expect(ai.project!.impliedGeneratorsNotWired).toEqual(["trace-helper"]);
    expect(ai.provides.generators).toEqual(["trace-helper"]);
  });

  test("`extendedBy` names the project entities that would break if you opted out", async () => {
    // The catalog-probe fixture has no entity extending a library base, so the
    // interesting arm is the one that finds one — see gen-libraries.test.ts for the
    // end-to-end path. Here: the field exists and is a real answer, not a null.
    const ai = (await libraryRows(["ai"])).find((r) => r.name === "ai")!;
    expect(Array.isArray(ai.project!.extendedBy)).toBe(true);
  });

  test("with no project there is no project block at all", async () => {
    const { buildLibraryRows } = await import("../src/lib/library-listing.js");
    const rows = await buildLibraryRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.project).toBeUndefined();
  });
});
