// `meta upgrade` end-to-end, against real files on disk.
//
// The unit tests prove the rewriter transforms text. These prove the COMMAND does the right
// thing to a project: previews without writing, writes only under --apply, and — the one
// that matters for CI — exits NON-ZERO while any refusal stands, so a partial upgrade
// cannot be recorded as a finished one.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradeCommand } from "../src/commands/upgrade.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function project(meta: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-upgrade-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.json"), meta, "utf8");
  return root;
}

const WITH_RETIRED = `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "requirement.functional": {
          "name": "orderRecord",
          "@level": 4,
          "@status": "live",
          "@statement": "An order records what was bought",
          "@counterexample": "An order that cannot say what was bought",
          "@verifiedBy": ["OrderServiceTest"]
      }}
    ]
  }
}`;

const NEEDS_DECISION = `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "requirement.functional": {
          "name": "oldThing",
          "@level": 4,
          "@status": "abandoned",
          "@statement": "Something we stopped doing",
          "@counterexample": "n/a"
      }}
    ]
  }
}`;

const CLEAN = `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "requirement.functional": {
          "name": "orderRecord",
          "@level": 4,
          "@status": "live",
          "@statement": "An order records what was bought",
          "@counterexample": "An order that cannot say what was bought"
      }}
    ]
  }
}`;

describe("meta upgrade", () => {
  test("PREVIEWS without writing by default", async () => {
    const root = await project(WITH_RETIRED);
    const code = await upgradeCommand([root], root);
    expect(code).toBe(0);
    // Untouched on disk — the default must never edit committed files.
    expect(await readFile(join(root, "metaobjects", "meta.json"), "utf8")).toBe(WITH_RETIRED);
  });

  test("--apply rewrites the file", async () => {
    const root = await project(WITH_RETIRED);
    expect(await upgradeCommand([root, "--apply"], root)).toBe(0);
    const after = await readFile(join(root, "metaobjects", "meta.json"), "utf8");
    expect(after).not.toContain("@verifiedBy");
    // Everything else survives, byte-for-byte in the untouched regions.
    expect(after).toContain('"@statement": "An order records what was bought"');
    expect(after).toContain('"name": "orderRecord"');
  });

  test("a project with nothing retired exits 0 and is untouched", async () => {
    const root = await project(CLEAN);
    expect(await upgradeCommand([root, "--apply"], root)).toBe(0);
    expect(await readFile(join(root, "metaobjects", "meta.json"), "utf8")).toBe(CLEAN);
  });

  // The CI-facing contract. A refusal means the metadata still will not load, so exiting 0
  // would let a pipeline record the migration as complete while the build is broken.
  test("EXITS NON-ZERO when a decision is still required", async () => {
    const root = await project(NEEDS_DECISION);
    expect(await upgradeCommand([root, "--apply"], root)).toBe(1);
    // And leaves the judgment case alone rather than guessing.
    expect(await readFile(join(root, "metaobjects", "meta.json"), "utf8")).toContain('"abandoned"');
  });

  test("--to bounds which retirements apply", async () => {
    const root = await project(WITH_RETIRED);
    // @verifiedBy retired in 0.24.0, so a 0.23.0 ceiling must leave it alone.
    expect(await upgradeCommand([root, "--to", "0.23.0", "--apply"], root)).toBe(0);
    expect(await readFile(join(root, "metaobjects", "meta.json"), "utf8")).toContain("@verifiedBy");
  });

  test("rejects an unknown flag with exit 2", async () => {
    const root = await project(CLEAN);
    expect(await upgradeCommand([root, "--nope"], root)).toBe(2);
  });

  // ── YAML estates (#339) ──
  //
  // These replace a test that pinned the OPPOSITE behaviour: YAML used to be named and
  // skipped, and the command exited 1 having examined nothing. That was the honest reading
  // of a rewriter that could not edit YAML; it is not a contract, and #339 is the report of
  // what it cost — a 161-file YAML estate carrying 405 retired constructs was handed
  // a bare "nothing found".

  async function yamlProject(...docs: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "meta-upgrade-yaml-"));
    dirs.push(root);
    await mkdir(join(root, "metaobjects"), { recursive: true });
    for (const [i, d] of docs.entries()) {
      await writeFile(join(root, "metaobjects", `meta${i}.yaml`), d, "utf8");
    }
    return root;
  }

  /** Run the command capturing everything it printed, so the CONCLUSION can be asserted. */
  async function run(args: string[], cwd: string): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const [origLog, origErr] = [console.log, console.error];
    console.log = (m?: unknown) => void lines.push(String(m));
    console.error = (m?: unknown) => void lines.push(String(m));
    try {
      return { code: await upgradeCommand(args, cwd), out: lines.join("\n") };
    } finally {
      [console.log, console.error] = [origLog, origErr];
    }
  }

  const YAML_RETIRED =
    "metadata:\n" +
    "  package: acme::shop\n" +
    "  children:\n" +
    "    - requirement.functional:\n" +
    "        name: orderRecord\n" +
    "        statement: An order records what was bought\n" +
    "        level: 4\n" +
    "        violation: an order that cannot say what was bought\n" +
    "        verifiedBy:\n" +
    "          - OrderServiceTest\n" +
    "          - OrderIT\n";

  test("rewrites a YAML estate — previewing by default, writing under --apply", async () => {
    const root = await yamlProject(YAML_RETIRED);
    const file = join(root, "metaobjects", "meta0.yaml");

    expect((await run([root], root)).code).toBe(0);
    expect(await readFile(file, "utf8")).toBe(YAML_RETIRED);

    expect((await run([root, "--apply"], root)).code).toBe(0);
    const after = await readFile(file, "utf8");
    expect(after).toContain("counterexample: an order that cannot say what was bought");
    expect(after).not.toContain("verifiedBy");
    expect(after).not.toContain("OrderIT");
    // Untouched regions survive byte-for-byte.
    expect(after).toContain("        statement: An order records what was bought\n");
  });

  // The half of #339 that is not about coverage: the conclusion must never be a bare
  // "not found", because it is the last line and it is the one that sticks.
  test("its conclusion states how many files it is a conclusion ABOUT", async () => {
    const clean = "metadata:\n  package: acme::shop\n  children: []\n";
    const { code, out } = await run([await yamlProject(clean, clean)], ".");
    expect(code).toBe(0);
    expect(out).toContain("nothing to rewrite (2 file(s) checked)");
  });

  // "I could not look" and "I looked and it is clean" must not share an exit code.
  test("a file it cannot parse is reported as NOT checked, with its own exit code", async () => {
    const broken = "metadata:\n  children:\n   - requirement.functional: { name: r, violation: x\n";
    const root = await yamlProject(broken);
    const { code, out } = await run([root, "--apply"], root);

    expect(code).toBe(3);
    expect(out).toContain("could not be parsed and were NOT checked");
    expect(out).toContain("0 file(s) checked, 1 NOT checked");
    expect(await readFile(join(root, "metaobjects", "meta0.yaml"), "utf8")).toBe(broken);
  });

  test("a YAML retirement needing a decision still exits 1, not 3", async () => {
    const root = await yamlProject(
      "metadata:\n  children:\n    - requirement.functional: { name: r, status: abandoned }\n",
    );
    expect((await run([root, "--apply"], root)).code).toBe(1);
  });
});
