/**
 * "Prove your gate fails" (docs/recipes/prove-your-gate-fails.md), executed.
 *
 * A CI gate that has never gone red is not yet a gate: `meta verify` exits 0 on a tree it
 * checked and ALSO on a tree it checked nothing of (no generators declared, wrong cwd, a
 * `generators: []` config). This test is the shape an adopter copies into their own repo:
 * generate, assert the clean tree passes, seed a deliberate break, assert the gate fails
 * with exit 1, restore, assert it passes again. If any step is missing the others prove
 * nothing, so the clean-tree check comes first and the restore check last.
 *
 * Runs the BUILT CLI under node, one process per command (the adopter path).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { meta, requireFreshDist } from "./support/built-cli.js";
import { newShopProject, SHOP_MODEL, writeModel } from "./support/generator-project.js";

beforeAll(requireFreshDist);

let root = "";
afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("meta verify is not a vacuous gate", () => {
  test("clean tree exits 0; metadata drift, a forbidden hand edit and a deleted file each exit 1", async () => {
    root = await newShopProject("verify-gate-");
    const configPath = join(root, "metaobjects.config.ts");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8")
        .replace(
          'import { defineConfig } from "@metaobjectsdev/cli";',
          'import { defineConfig } from "@metaobjectsdev/cli";\nimport { entityFile, queriesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";',
        )
        .replace("generators: [],", "generators: [entityFile(), queriesFile(), barrel()],"),
    );

    // 0. The gate must actually have something to check, or exit 0 below means nothing.
    expect(await meta(root, "gen")).toMatchObject({ exit: 0 });
    const customer = join(root, "src", "generated", "Customer.ts");
    const pristine = readFileSync(customer, "utf8");

    // 1. Clean tree: exit 0.
    const clean = await meta(root, "verify");
    expect({ step: "clean", exit: clean.exit }).toEqual({ step: "clean", exit: 0 });

    // 2. Break A: change the model and do NOT regenerate. Code no longer matches metadata.
    const model = structuredClone(SHOP_MODEL);
    const customerNode = model.metadata.children.find((c) => "object.entity" in c && c["object.entity"].name === "Customer");
    (customerNode as { "object.entity": { children: unknown[] } })["object.entity"].children.push({
      "field.string": { name: "nickname", "@maxLength": 50 },
    });
    writeModel(root, model);
    const metadataDrift = await meta(root, "verify");
    expect({ step: "metadata drift", exit: metadataDrift.exit }).toEqual({ step: "metadata drift", exit: 1 });
    expect(metadataDrift.output).toContain("codegen");

    // 3. Restore the model: green again (the failure was the break, not the harness).
    writeModel(root, SHOP_MODEL);
    expect((await meta(root, "verify")).exit).toBe(0);

    // 4. A hand edit inside a generated file is NOT drift by default: `meta gen` three-way-merges
    //    it, so plain `verify` stays green. A team that wants generated code untouchable opts in
    //    with --forbid-hand-edits; that is the gate to assert if that is your policy.
    const edit = pristine.replace(/email: (\w+)\("email"\)/, 'emailAddress: $1("email")');
    expect(edit).not.toBe(pristine);
    writeFileSync(customer, edit);
    expect((await meta(root, "verify")).exit).toBe(0);
    const edited = await meta(root, "verify", "--codegen", "--forbid-hand-edits");
    expect({ step: "edited generated part", exit: edited.exit }).toEqual({ step: "edited generated part", exit: 1 });
    writeFileSync(customer, pristine);

    // 5. Break C: a generated file removed.
    unlinkSync(customer);
    const deleted = await meta(root, "verify");
    expect({ step: "deleted generated file", exit: deleted.exit }).toEqual({ step: "deleted generated file", exit: 1 });

    // 6. Regenerate: green. `meta gen` is the fix the failure message points at.
    expect(await meta(root, "gen")).toMatchObject({ exit: 0 });
    expect((await meta(root, "verify")).exit).toBe(0);
  }, 240_000);

  test("a project that declares no generators passes verify, which is why step 0 above exists", async () => {
    const empty = await newShopProject("verify-gate-empty-");
    try {
      const gen = await meta(empty, "gen");
      expect(gen.exit).toBe(0);
      const verify = await meta(empty, "verify");
      // Nothing declared, nothing checked, nothing to fail. Exit 0 here proves nothing.
      expect(verify.exit).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 120_000);
});
