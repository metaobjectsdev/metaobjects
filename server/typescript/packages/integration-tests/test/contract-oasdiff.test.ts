// FR-022 — the release check, run for real: two emitted OpenAPI documents through oasdiff, the
// tool docs/features/contract-emitters.md tells a project to use. It proves stock oasdiff reads what
// the generator writes, and that a change to the model shows up as the change it is: adding an
// optional field is compatible, and removing one breaks consumers.
//
// oasdiff comes from PATH, else from the pinned image through Docker. With neither, the test is
// skipped and says why, the way the lanes that need a container do.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineConfig, runGen } from "@metaobjectsdev/codegen-ts";
import { openApiFile } from "@metaobjectsdev/codegen-ts/generators";
import { loadUris } from "@metaobjectsdev/metadata";
import { pathToFileURL } from "node:url";

const OASDIFF_IMAGE = "tufin/oasdiff:v1.35.0";
const TIMEOUT_MS = 180_000;

type Runner = (args: string[], dir: string) => { status: number | null; stdout: string; stderr: string };

function succeeds(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

function findRunner(): Runner | undefined {
  if (succeeds("oasdiff", ["--version"])) {
    return (args, dir) => {
      const r = spawnSync("oasdiff", args, { cwd: dir, encoding: "utf8" });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
  }
  // Docker alone is not enough: the image has to be here, or pullable.
  if (!succeeds("docker", ["run", "--rm", OASDIFF_IMAGE, "--version"])) return undefined;
  return (args, dir) => {
    const r = spawnSync("docker", ["run", "--rm", "-v", `${dir}:/work`, "-w", "/work", OASDIFF_IMAGE, ...args], { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}

const BASE_META = {
  "metadata.root": {
    package: "acme::oasdiff",
    children: [{
      "object.entity": {
        name: "Customer",
        children: [
          { "source.rdb": { "@table": "customers" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "name", "@required": true, "@maxLength": 100, "@filterable": true } },
          { "field.string": { name: "nickname", "@maxLength": 100 } },
          { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        ],
      },
    }],
  },
};

type Child = Record<string, Record<string, unknown>>;

function customerWith(change: (children: Child[]) => Child[]): unknown {
  const copy = structuredClone(BASE_META);
  const entity = copy["metadata.root"].children[0]!["object.entity"];
  entity.children = change(entity.children as Child[]) as typeof entity.children;
  return copy;
}

async function emitDocument(meta: unknown, dir: string, name: string): Promise<void> {
  const metaPath = join(dir, `${name}.meta.json`);
  writeFileSync(metaPath, JSON.stringify(meta));
  const result = await loadUris([pathToFileURL(metaPath).href]);
  expect(result.errors).toEqual([]);
  const outDir = join(dir, `${name}-out`);
  await runGen({
    config: defineConfig({ outDir, dialect: "postgres", apiPrefix: "/api", generators: [openApiFile({ title: "Customers", version: "1.0.0" })] }),
    metadata: result.root,
    genStateDir: join(dir, `${name}-state`),
  });
  const target = join(dir, `${name}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(join(outDir, "openapi.json"), "utf8"));
}

const runner = findRunner();

describe.skipIf(runner === undefined)("a change to the model, through oasdiff", () => {
  // WARN, not ERR: oasdiff grades a removed query parameter a warning, because most APIs ignore one
  // they do not know. These routes answer it with a 400, so here it breaks a consumer.
  const breakingArgs = ["breaking", "base.json", "revision.json", "--fail-on", "WARN"];

  async function compare(revision: unknown): Promise<{ status: number | null; output: string }> {
    const dir = mkdtempSync(join(resolve(tmpdir()), "contract-oasdiff-"));
    try {
      await emitDocument(BASE_META, dir, "base");
      await emitDocument(revision, dir, "revision");
      const { status, stdout, stderr } = runner!(breakingArgs, dir);
      return { status, output: stdout + stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("oasdiff reads the document and finds nothing against itself", async () => {
    const { status, output } = await compare(BASE_META);
    expect(output).not.toContain("error:");
    expect(status).toBe(0);
  }, { timeout: TIMEOUT_MS });

  test("adding an optional field is compatible", async () => {
    const added = customerWith((children) => [
      ...children.slice(0, 3),
      { "field.string": { name: "city", "@maxLength": 60 } },
      ...children.slice(3),
    ]);
    const { status, output } = await compare(added);
    expect(output).not.toContain("error:");
    expect(status).toBe(0);
  }, { timeout: TIMEOUT_MS });

  test("a list keeps its components, so a new field is no change to its oneOf", async () => {
    const { output } = await compare(customerWith((children) => [
      ...children.slice(0, 3),
      { "field.string": { name: "city", "@maxLength": 60 } },
      ...children.slice(3),
    ]));
    expect(output).not.toContain("one-of");
  }, { timeout: TIMEOUT_MS });

  test("removing a field breaks consumers, and oasdiff says which", async () => {
    const removed = customerWith((children) => children.filter((child) => child["field.string"]?.["name"] !== "nickname"));
    const { status, output } = await compare(removed);
    expect(status).toBe(1);
    expect(output).toContain("nickname");
  }, { timeout: TIMEOUT_MS });

  test("a new required field breaks consumers: every existing create is refused", async () => {
    const required = customerWith((children) => [
      ...children.slice(0, 3),
      { "field.string": { name: "city", "@required": true, "@maxLength": 60 } },
      ...children.slice(3),
    ]);
    const { status, output } = await compare(required);
    expect(status).toBe(1);
    expect(output).toContain("city");
  }, { timeout: TIMEOUT_MS });

  test("tightening a bound breaks consumers: a valid request is now refused", async () => {
    const tightened = customerWith((children) => children.map((child) => {
      const field = child["field.string"];
      return field?.["name"] === "nickname" ? { "field.string": { ...field, "@maxLength": 10 } } : child;
    }));
    const { status, output } = await compare(tightened);
    expect(status).toBe(1);
    expect(output).toContain("max-length-decreased");
  }, { timeout: TIMEOUT_MS });

  test("a new entity breaks nobody", async () => {
    const withOrder = customerWith((children) => children);
    const root = withOrder as typeof BASE_META;
    root["metadata.root"].children.push({
      "object.entity": {
        name: "Invoice",
        children: [
          { "source.rdb": { "@table": "invoices" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        ],
      },
    } as never);
    const { status, output } = await compare(withOrder);
    expect(output).not.toContain("error:");
    expect(status).toBe(0);
  }, { timeout: TIMEOUT_MS });

  test("removing a filter breaks consumers: the document holds the query surface too", async () => {
    const unfiltered = customerWith((children) => children.map((child) => {
      const field = child["field.string"];
      if (field?.["name"] !== "name") return child;
      const { "@filterable": _dropped, ...rest } = field;
      return { "field.string": rest };
    }));
    const { status, output } = await compare(unfiltered);
    expect(status).toBe(1);
    expect(output).toContain("filter[name]");
  }, { timeout: TIMEOUT_MS });
});
