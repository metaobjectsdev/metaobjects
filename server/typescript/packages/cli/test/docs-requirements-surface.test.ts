// `meta docs` — the `requirements` surface, end to end through the real command.
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md §6
//
// THE DEFAULT-ON DECISION IS WHAT THESE TESTS GUARD. `requirements` joined the default
// surface set, so the safety property is not "the feature works" — it is that a project
// declaring NO requirement.* node sees no new file at all. If that breaks, every existing
// adopter's `meta docs` grows an artifact they never asked for, on upgrade.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsCommand } from "../src/commands/docs.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const entity = (name: string, table: string) => ({
  "object.entity": {
    name,
    children: [
      { "field.long": { name: "id" } },
      { "field.string": { name: "label" } },
      { "source.rdb": { "@table": table } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
    ],
  },
});

const WITH_LEDGER = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      entity("Order", "orders"),
      entity("Audit", "audits"),
      {
        "requirement.functional": {
          name: "checkout",
          "@level": 2,
          "@status": "live",
          "@statement": "A shopper can pay for a basket.",
          "@violation": "A basket that cannot be paid for.",
          children: [
            {
              "requirement.functional": {
                name: "capture",
                "@level": 4,
                "@status": "live",
                "@statement": "An order records what was captured.",
                "@violation": "An order that cannot say what was charged.",
                "@implementedBy": ["acme::shop::Order"],
              },
            },
          ],
        },
      },
    ],
  },
};

const NO_LEDGER = {
  "metadata.root": {
    package: "acme::shop",
    children: [entity("Order", "orders"), entity("Audit", "audits")],
  },
};

async function project(model: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-docs-req-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.json"), JSON.stringify(model), "utf8");
  return root;
}

describe("meta docs — the requirements surface", () => {
  test("emits both artifacts by DEFAULT, with no flag", async () => {
    const root = await project(WITH_LEDGER);
    const out = join(root, "docs");
    expect(await docsCommand([root, "--out", out], root)).toBe(0);
    expect(existsSync(join(out, "requirements.md"))).toBe(true);
    expect(existsSync(join(out, "requirements.toon"))).toBe(true);
  });

  // The safety property behind default-on. NOT "an empty file" — no file.
  test("a project with NO ledger gets NO requirements file", async () => {
    const root = await project(NO_LEDGER);
    const out = join(root, "docs");
    expect(await docsCommand([root, "--out", out], root)).toBe(0);
    expect(existsSync(join(out, "requirements.md"))).toBe(false);
    expect(existsSync(join(out, "requirements.toon"))).toBe(false);
    // ...while the model surface still emitted, proving the run itself worked and the
    // absence above is the guard rather than a silently failed command.
    expect(existsSync(join(out, "Order.md"))).toBe(true);
  });

  test("--requirements narrows to this surface alone", async () => {
    const root = await project(WITH_LEDGER);
    const out = join(root, "docs");
    expect(await docsCommand([root, "--out", out, "--requirements"], root)).toBe(0);
    expect(existsSync(join(out, "requirements.md"))).toBe(true);
    expect(existsSync(join(out, "Order.md"))).toBe(false);
  });

  test("the emitted markdown carries the ledger's nesting", async () => {
    const root = await project(WITH_LEDGER);
    const out = join(root, "docs");
    expect(await docsCommand([root, "--out", out, "--requirements"], root)).toBe(0);
    const md = await readFile(join(out, "requirements.md"), "utf8");
    expect(md).toContain("## checkout");
    expect(md).toContain("### checkout.capture");
  });

  test("the emitted TOON declares its row count", async () => {
    const root = await project(WITH_LEDGER);
    const out = join(root, "docs");
    expect(await docsCommand([root, "--out", out, "--requirements"], root)).toBe(0);
    const toon = await readFile(join(out, "requirements.toon"), "utf8");
    expect(toon).toContain("requirements[2]");
  });

  // Shape C, through the real render path rather than the data builder.
  test("a claimed entity's page names the requirement; an unclaimed one does not", async () => {
    const root = await project(WITH_LEDGER);
    const out = join(root, "docs");
    expect(await docsCommand([root, "--out", out], root)).toBe(0);
    const order = await readFile(join(out, "Order.md"), "utf8");
    const audit = await readFile(join(out, "Audit.md"), "utf8");
    expect(order).toContain("## Required by");
    expect(order).toContain("checkout.capture");
    expect(audit).not.toContain("## Required by");
  });

  // Design §3 — no join key exists, so no surface may imply one.
  test("no emitted file claims a test link", async () => {
    const root = await project(WITH_LEDGER);
    const out = join(root, "docs");
    expect(await docsCommand([root, "--out", out], root)).toBe(0);
    const md = (await readFile(join(out, "requirements.md"), "utf8")).toLowerCase();
    expect(md).not.toContain("verified");
    expect(md).not.toContain(".test.ts");
  });
});
