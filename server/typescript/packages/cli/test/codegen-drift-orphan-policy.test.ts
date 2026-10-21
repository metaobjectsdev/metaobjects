import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { runGen, type Generator, type MetaobjectsGenConfig, type OrphanPolicy } from "@metaobjectsdev/codegen-ts";
import { computeCodegenDrift } from "../src/lib/codegen-drift.js";

const OUT = "gen";

async function model(...names: string[]): Promise<MetaRoot> {
  const doc = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: names.map((name) => ({
        "object.value": { name, children: [{ "field.string": { name: "x" } }] },
      })),
    },
  });
  const r = await new MetaDataLoader().load([new InMemoryStringSource(doc)]);
  if (r.errors.length > 0) throw new Error(r.errors.map((e) => e.message).join("\n"));
  return r.root;
}

const stubs = (orphanPolicy: OrphanPolicy, names: readonly string[]): Generator => ({
  name: "stubs",
  generate: () => names.map((name) => ({ path: `stubs/${name}.txt`, content: `${name}\n` })),
  orphanPolicy,
});

const owns = (rel: string): boolean => rel.startsWith("stubs/");

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "drift-orphan-policy-"));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

const config = (policy: OrphanPolicy, names: readonly string[]): MetaobjectsGenConfig => ({
  outDir: OUT,
  extStyle: "js",
  generators: [stubs(policy, names)],
});

async function gen(policy: OrphanPolicy, ...names: string[]) {
  return runGen({ config: config(policy, names), metadata: await model(...names), projectRoot });
}

describe("verify --codegen classifies orphans by the sweep's own policy", () => {
  test("a kept orphan is not drift, and gen keeps it", async () => {
    const policy: OrphanPolicy = { owns, keep: true };
    await gen(policy, "A", "B");
    const orphan = join(projectRoot, OUT, "stubs", "B.txt");

    const drift = await computeCodegenDrift(config(policy, ["A"]), await model("A"), projectRoot);
    expect(drift.driftedFiles).toEqual([]);
    expect(drift.lines).toEqual([]);
    expect(drift.clean).toBe(true);

    await gen(policy, "A");
    expect(existsSync(orphan)).toBe(true);
  });

  test("an edited orphan under a force policy is reported as deleted by gen, and gen deletes it", async () => {
    const policy: OrphanPolicy = { owns, force: true };
    await gen(policy, "A", "B");
    const orphan = join(projectRoot, OUT, "stubs", "B.txt");
    writeFileSync(orphan, `${readFileSync(orphan, "utf8")}// mine\n`);

    const drift = await computeCodegenDrift(config(policy, ["A"]), await model("A"), projectRoot);
    expect(drift.editedOrphans).toEqual([]);
    expect(drift.driftedFiles).toEqual([join(OUT, "stubs", "B.txt")]);
    expect(drift.lines.join("\n")).toContain("'meta gen' deletes it");

    await gen(policy, "A");
    expect(existsSync(orphan)).toBe(false);
  });

  test("an edited orphan without force stays an edited orphan, and gen refuses it", async () => {
    const policy: OrphanPolicy = { owns };
    await gen(policy, "A", "B");
    const orphan = join(projectRoot, OUT, "stubs", "B.txt");
    writeFileSync(orphan, `${readFileSync(orphan, "utf8")}// mine\n`);

    const drift = await computeCodegenDrift(config(policy, ["A"]), await model("A"), projectRoot);
    expect(drift.editedOrphans).toEqual([join(OUT, "stubs", "B.txt")]);

    await gen(policy, "A");
    expect(existsSync(orphan)).toBe(true);
  });
});

describe("a declared outDir no selected generator writes", () => {
  const plain = (target?: string): Generator => ({
    name: "plain",
    generate: () => [{ path: "A.txt", content: "A\n" }],
    ...(target !== undefined && { target }),
  });
  const moved: MetaobjectsGenConfig = {
    outDir: OUT,
    extStyle: "js",
    targets: { web: { outDir: "web" } },
    generators: [plain("web")],
  };

  test("verify reports its recorded file as deleted by gen, gen deletes it, and verify is then clean", async () => {
    await runGen({ config: { outDir: OUT, extStyle: "js", generators: [plain()] }, metadata: await model("A"), projectRoot });
    const left = join(projectRoot, OUT, "A.txt");
    expect(existsSync(left)).toBe(true);

    const drift = await computeCodegenDrift(moved, await model("A"), projectRoot);
    expect(drift.lines.join("\n")).toContain(`${join(OUT, "A.txt")} (committed but regen would not emit it; 'meta gen' deletes it)`);

    await runGen({ config: moved, metadata: await model("A"), projectRoot });
    expect(existsSync(left)).toBe(false);
    expect(existsSync(join(projectRoot, "web", "A.txt"))).toBe(true);
    expect((await computeCodegenDrift(moved, await model("A"), projectRoot)).clean).toBe(true);
  });
});
