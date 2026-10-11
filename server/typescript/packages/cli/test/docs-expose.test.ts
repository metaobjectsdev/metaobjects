// `meta docs` honours the `expose` option of the project's routes generator: the API pages list
// the verbs the routes file mounts and no others (adopter report).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsCommand } from "../src/commands/docs.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const META = {
  "metadata.root": {
    package: "acme::shop",
    children: [{
      "object.entity": {
        name: "AuditEntry",
        children: [
          { "source.rdb": { "@table": "audit_entries" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "note" } },
          { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
        ],
      },
    }],
  },
};

// A routes generator as an owned `routesFile({ expose })` presents itself to the docs door: the
// `mountsRoutes` marker carries the option.
// `hono` is the marker of a second, Hono routes generator in the same suite (or "").
const config = (marker: string, hono = "") => [
  `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
  `const routes = { name: "routes-file", ${marker} generate: () => [] };`,
  `const honoRoutes = { name: "routes-file-hono", emitsHonoRoutes: true, ${hono} generate: () => [] };`,
  `export default defineConfig({ outDir: "out", dialect: "sqlite", generators: [routes${hono ? ", honoRoutes" : ""}] });`,
].join("\n");

async function docsFor(marker: string, hono = ""): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-docs-expose-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.json"), JSON.stringify(META), "utf8");
  await writeFile(join(root, "metaobjects.config.ts"), config(marker, hono), "utf8");
  const out = join(root, "docs-out");
  expect(await docsCommand([root, "--out", out], root)).toBe(0);
  return readFile(join(out, "api", "acme", "shop", "AuditEntry.md"), "utf8").catch(() =>
    readFile(join(out, "api", "AuditEntry.md"), "utf8"));
}

describe("meta docs and routesFile({ expose })", () => {
  test("a routes generator that exposes list and get documents no write verb", async () => {
    const page = await docsFor(`mountsRoutes: { expose: ["list", "get"] },`);
    expect(page).toContain("GET /audit_entries");
    expect(page).not.toMatch(/DELETE \/audit_entries/);
    expect(page).not.toMatch(/POST \/audit_entries/);
    expect(page).not.toMatch(/PATCH \/audit_entries/);
  });

  test("with no expose the page still lists every verb", async () => {
    const page = await docsFor(`mountsRoutes: {},`);
    expect(page).toContain("DELETE /audit_entries");
    expect(page).toContain("POST /audit_entries");
  });

  test("a narrowed Fastify routes file beside a default Hono one narrows only the Fastify section", async () => {
    const page = await docsFor(`mountsRoutes: { expose: ["list", "get"] },`, `mountsRoutes: {},`);
    const at = page.indexOf("[Hono]");
    expect(at).toBeGreaterThan(-1);
    const fastify = page.slice(0, page.indexOf("[Hono] List"));
    expect(fastify).not.toMatch(/DELETE \/audit_entries/);
    expect(page.slice(at)).toContain("DELETE /audit_entries");
  });

  test("a narrowed Hono routes file beside a default Fastify one narrows only the Hono section", async () => {
    const page = await docsFor(`mountsRoutes: {},`, `mountsRoutes: { expose: ["list", "get"] },`);
    expect(page).toContain("DELETE /audit_entries");
    expect(page.slice(page.indexOf("[Hono] List"))).not.toMatch(/DELETE \/audit_entries/);
  });
});
