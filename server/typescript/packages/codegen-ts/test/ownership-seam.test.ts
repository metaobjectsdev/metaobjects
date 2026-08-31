// The ownership seam, pinned.
//
// Every case here corresponds to a sentence some shipped surface used to state as a
// mechanism when no mechanism existed. A doc-only correction leaves the next drift
// undetected, so each corrected claim gets an assertion that fails if the product ever
// stops matching the words:
//
//   1. `<Entity>.extra.ts` is a CONVENTION — the barrel does not re-export it, and
//      `EXTRA_SUFFIX` (the exported constant that implied the engine knew the name) is
//      gone.
//   2. The `requirementTests()` survival promise is MACHINE-LOCAL: merged where the
//      `.gen-state` snapshot body exists, refused everywhere else. Both arms are run,
//      because the refusing arm alone would pass against a build that never merges.
//   3. The refusal names no remedy a `requirementTests()` owner cannot perform, and the
//      recovery that DOES keep the edit is printed once per run rather than per file.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../src/index.js";
import * as codegenTs from "../src/index.js";
import { requirementTests } from "../src/generators/requirement-tests.js";
import { entityFile, barrel } from "../src/generators/index.js";
import { renderRequirementTest } from "../src/templates/requirement-test.js";
import type { RequirementTestArgs } from "../src/templates/requirement-test.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-ownership-seam-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const MODEL = {
  "metadata.root": {
    package: "acme::probe",
    children: [
      {
        "object.entity": {
          name: "Council",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "slug" } },
            { "source.rdb": { "@table": "councils" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "requirement.functional": {
          name: "links",
          "@level": 3,
          "@status": "live",
          "@statement": "Links are shareable.",
          "@counterexample": "an opaque id in the URL",
          children: [
            {
              "requirement.functional": {
                name: "slugField",
                "@level": 4,
                "@status": "live",
                "@statement": "A council has a human-readable slug.",
                "@counterexample": "a council with no slug",
                "@implementedBy": ["Council", "Council.slug"],
              },
            },
          ],
        },
      },
    ],
  },
};

async function loadRoot() {
  const r = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MODEL)),
  ]);
  if (r.errors.length > 0) {
    throw new Error(`Loader errors:\n${r.errors.map((e) => e.message).join("\n")}`);
  }
  return r.root;
}

const MY_BODY = "MY HAND-WRITTEN ASSERTION";

/** Replace the generated red stub body with a real assertion, as the header instructs. */
function writeMyBody(path: string): void {
  const edited = readFileSync(path, "utf-8").replace(
    /expect\.unreachable\([\s\S]*?\);/,
    `expect(1).toBe(1); // ${MY_BODY}`,
  );
  if (edited === readFileSync(path, "utf-8")) {
    throw new Error("stub body did not match — the red-stub shape changed");
  }
  writeFileSync(path, edited);
}

/** What a fresh clone has: the committed hash manifest, none of the gitignored bodies. */
function dropSnapshotBodies(projectRoot: string): void {
  const genState = join(projectRoot, ".metaobjects", ".gen-state");
  for (const entry of readdirSync(genState)) {
    if (entry !== ".hashes.json") {
      rmSync(join(genState, entry), { recursive: true, force: true });
    }
  }
  expect(readdirSync(genState)).toEqual([".hashes.json"]);
}

describe("`<Entity>.extra.ts` is a convention, not a mechanism", () => {
  test("EXTRA_SUFFIX is not a public export — nothing may imply the engine knows the name", () => {
    // It was exported and used by no generator, no orphan sweep and no write path, while
    // five generated-output sites pointed at the name. An export is a promise of support.
    expect(Object.keys(codegenTs)).not.toContain("EXTRA_SUFFIX");
  });

  test("the generated barrel does not re-export a sibling module in the same directory", async () => {
    const root = await loadRoot();
    const config = defineConfig({
      outDir: tmp,
      extStyle: "js",
      dbImport: "~/server/db",
      dialect: "sqlite",
      generators: [entityFile(), barrel()],
    });
    await runGen({ config, metadata: root, projectRoot: tmp });

    // Create the sibling the generated output points at, then regenerate.
    writeFileSync(join(tmp, "Council.extra.ts"), "export const mine = 1;\n");
    await runGen({ config, metadata: root, projectRoot: tmp });

    const index = readFileSync(join(tmp, "index.ts"), "utf-8");
    expect(index).toContain("./Council.js");
    // The barrel is a pure function of the MODEL, deliberately — a directory-listing
    // barrel would make generated output depend on what happens to be on disk. So the
    // sibling has to be imported directly, and the docs must not imply otherwise.
    expect(index).not.toContain("Council.extra");
    // ...and creating it must never put the sibling at risk.
    expect(readFileSync(join(tmp, "Council.extra.ts"), "utf-8")).toContain("export const mine");
  });
});

describe("the requirementTests() stub header states the CONDITION on survival", () => {
  const base: RequirementTestArgs = {
    view: {
      subType: "functional",
      level: 4,
      status: "live",
      path: "links.slugField",
      implementedByTypes: [],
    },
    concern: "object.entity",
    statement: "A council has a human-readable slug.",
    counterexample: "a council with no slug",
    targets: [],
  };

  test("it names the machine-local half, and no longer promises survival flat", () => {
    const src = renderRequirementTest(base);
    // The identity/link half is unchanged and still load-bearing.
    expect(src).toContain("the BODY below is yours");
    expect(src).toContain("the name is the link");
    // The half that was false everywhere but the generating machine: BOTH outcomes are
    // named, and so is the condition that selects between them.
    expect(src).toContain(".gen-state");
    expect(src).toContain("MERGED where");
    expect(src).toContain("REFUSED (run exits 1, body kept)");
    expect(src).toContain("gitignored");
    // The old wording asserted the promise with no condition attached.
    expect(src).not.toContain("and survives regeneration.");
  });
});

describe("regenerating a hand-written requirement stub", () => {
  test("MERGES on the machine that generated it, REFUSES on a fresh clone — body intact in both", async () => {
    const root = await loadRoot();
    const config = defineConfig({
      outDir: tmp,
      extStyle: "js",
      dialect: "sqlite",
      generators: [requirementTests()],
    });

    const first = await runGen({ config, metadata: root, projectRoot: tmp });
    const stub = first.files[0]?.path;
    expect(stub).toBeDefined();
    writeMyBody(stub!);

    // Arm 1 — snapshot body present. This arm is what makes the header's promise true at
    // all, and it must be asserted: a suite that only checked the refusal would pass
    // against a build that never merges anything.
    const sameMachine = await runGen({ config, metadata: root, projectRoot: tmp });
    expect(sameMachine.files.map((f) => f.status)).toContain("merged");
    expect(readFileSync(stub!, "utf-8")).toContain(MY_BODY);

    // Arm 2 — the fresh clone / CI runner.
    dropSnapshotBodies(tmp);
    const freshClone = await runGen({ config, metadata: root, projectRoot: tmp });
    expect(freshClone.files.map((f) => f.status)).toContain("refused");
    // The floor holds: refusing is correct, and the body is what it protects.
    expect(readFileSync(stub!, "utf-8")).toContain(MY_BODY);

    const refusal = freshClone.warnings.find((w) => w.startsWith("Refused to overwrite"));
    expect(refusal).toBeDefined();
    // Neither remedy the hint used to name is possible for THIS generator: the body
    // cannot move out (the test name is the link to the requirement, and the header
    // forbids renaming it), and --baseline=fresh discards the only content the file has.
    expect(refusal).not.toContain("Move your edits into a non-generated file");
    expect(refusal).not.toContain("discard them and adopt fresh output");
    // What it does say is what happened, and that nothing was lost.
    expect(refusal).toContain("no .gen-state snapshot body");
    expect(refusal).toContain("intact on disk");

    // The recovery is run-level and printed exactly once, however many files refused —
    // per-file repetition is what buries an instruction.
    const recovery = freshClone.warnings.filter((w) => w.includes("--baseline=fresh"));
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toContain("git checkout --");
    expect(recovery[0]).toContain("requirementTests()");
  });

  test("the documented recovery restores the edit and turns the run green", async () => {
    const root = await loadRoot();
    const config = defineConfig({
      outDir: tmp,
      extStyle: "js",
      dialect: "sqlite",
      generators: [requirementTests()],
    });

    const first = await runGen({ config, metadata: root, projectRoot: tmp });
    const stub = first.files[0]!.path;
    writeMyBody(stub);
    await runGen({ config, metadata: root, projectRoot: tmp });
    dropSnapshotBodies(tmp);

    // Step 0 of the documented sequence is "the edit must be COMMITTED" — git is what
    // holds it while step 1 overwrites the working copy. Standing in for git here.
    const committed = readFileSync(stub, "utf-8");

    // Step 1: seed the missing merge base. This DOES overwrite — that is the point, and
    // why the doc leads with the commit.
    const seeded = await runGen({ config, metadata: root, projectRoot: tmp, baseline: "fresh" });
    expect(seeded.files.map((f) => f.status)).toContain("overwrite");
    expect(readFileSync(stub, "utf-8")).not.toContain(MY_BODY);

    // Step 2: `git checkout -- <path>`.
    writeFileSync(stub, committed);

    // Step 3: with a base present, the merge the header promises finally runs here too.
    const merged = await runGen({ config, metadata: root, projectRoot: tmp });
    expect(merged.files.map((f) => f.status)).toContain("merged");
    expect(merged.files.map((f) => f.status)).not.toContain("refused");
    expect(readFileSync(stub, "utf-8")).toContain(MY_BODY);
  });
});
