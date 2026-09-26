/**
 * `meta generator new` end to end, the way an adopter meets it: scaffold → `meta gen` →
 * `meta verify --codegen` clean → change the MODEL → verify convicts the stale output.
 *
 * The promise under test is "you start from something that already runs": the scaffold is
 * wired, generates real output from the model, typechecks strictly, and is drift-gated with
 * nothing registered by hand. One test per scope, because each scope is a different skeleton.
 *
 * Built CLI, one process per command (support/built-cli.ts explains why in-process lies).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { meta, requireFreshDist } from "./support/built-cli.js";
import { SHOP_MODEL, newShopProject, typecheckGenerators, writeModel } from "./support/generator-project.js";

beforeAll(requireFreshDist);

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** The model with one more field on OrderLine — what a real edit looks like. */
function modelWithExtraField(): unknown {
  const model = structuredClone(SHOP_MODEL) as typeof SHOP_MODEL;
  const line = model.metadata.children.find(
    (c) => (c as Record<string, { name?: string }>)["object.entity"]?.name === "OrderLine",
  ) as { "object.entity": { children: unknown[] } };
  line["object.entity"].children.push({ "field.string": { name: "note" } });
  return model;
}

const CASES = [
  { scope: "entity", name: "field-list", out: "src/generated/field-list/shop/OrderLine.json" },
  { scope: "package", name: "package-index", out: "src/generated/package-index/shop.json" },
  { scope: "model", name: "model-summary", out: "src/generated/model-summary.json" },
] as const;

describe("meta generator new — scaffold, gen, verify", () => {
  for (const c of CASES) {
    test(`--scope ${c.scope}: runs, typechecks, and is drift-gated`, async () => {
      const root = await newShopProject(`gen-new-${c.scope}-`);
      roots.push(root);

      const scaffolded = await meta(root, "generator", "new", c.name, "--scope", c.scope);
      expect({ step: "scaffold", ...scaffolded }).toMatchObject({ step: "scaffold", exit: 0 });
      expect(scaffolded.output).toContain("Wired it into metaobjects.config.ts");
      const config = readFileSync(join(root, "metaobjects.config.ts"), "utf8");
      expect(config).toContain(`from "./codegen/generators/${c.name}.js";`);

      const tsc = await typecheckGenerators(root, [`codegen/generators/${c.name}.ts`]);
      expect({ step: "tsc", ...tsc }).toMatchObject({ step: "tsc", exit: 0 });

      expect(await meta(root, "gen")).toMatchObject({ exit: 0 });
      expect(existsSync(join(root, c.out))).toBe(true);
      const emitted = readFileSync(join(root, c.out), "utf8");
      // It read the model through the resolving accessors: OrderLine's inherited fields are
      // there, the inherited array is an array, and the abstract base has no file of its own.
      expect(emitted).toContain('"name": "createdAt"');
      expect(emitted).toContain('"values": [');
      expect(emitted).not.toContain('"name": "BaseEntity"');
      if (c.scope !== "entity") expect(emitted).toContain('"ref": "shop::Address"');

      const clean = await meta(root, "verify", "--codegen");
      expect({ step: "verify clean", ...clean }).toMatchObject({ step: "verify clean", exit: 0 });

      writeModel(root, modelWithExtraField());
      const stale = await meta(root, "verify", "--codegen");
      expect(stale.exit).not.toBe(0);
      expect(stale.output).toContain("codegen drift");
    }, 180_000);
  }

  test("the entity skeleton describes an inherited array as an array", async () => {
    const root = await newShopProject("gen-new-array-");
    roots.push(root);
    expect(await meta(root, "generator", "new", "field-list")).toMatchObject({ exit: 0 });
    expect(await meta(root, "gen")).toMatchObject({ exit: 0 });
    const doc = JSON.parse(readFileSync(join(root, "src/generated/field-list/shop/Customer.json"), "utf8")) as {
      fields: Array<{ name: string; array: boolean; ref?: string }>;
    };
    expect(doc.fields.find((f) => f.name === "labels")?.array).toBe(true);
    expect(doc.fields.find((f) => f.name === "shipping")?.ref).toBe("shop::Address");
  }, 120_000);

  test("refuses a reference generator's name and points at eject", async () => {
    const root = await newShopProject("gen-new-refuse-");
    roots.push(root);
    const r = await meta(root, "generator", "new", "entity");
    expect(r.exit).toBe(2);
    expect(r.output).toContain("meta eject entity");
  }, 120_000);

  test("never clobbers an owned generator without --force", async () => {
    const root = await newShopProject("gen-new-clobber-");
    roots.push(root);
    expect(await meta(root, "generator", "new", "field-list")).toMatchObject({ exit: 0 });
    const file = join(root, "codegen/generators/field-list.ts");
    writeFileSync(file, "// MINE\n");
    const again = await meta(root, "generator", "new", "field-list");
    expect(again.exit).toBe(2);
    expect(readFileSync(file, "utf8")).toBe("// MINE\n");
  }, 120_000);
});
