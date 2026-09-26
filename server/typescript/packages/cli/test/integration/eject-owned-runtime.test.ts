/**
 * ADR-0034 Amendment 3 (2026-09-24) — an ejected helper is ALL the adopter's code.
 *
 * `meta eject routes` used to hand over a generator whose output still imported its HTTP
 * adapter (mount helpers, filter parser, error envelopes, pagination) from
 * `@metaobjectsdev/runtime-ts`, so a defect there still waited on an upstream release.
 * Eject now copies that adapter SOURCE into `codegen/runtime/` and the ejected generators
 * point their output at it.
 *
 * This runs the adopter's sequence against a project that does NOT have
 * `@metaobjectsdev/runtime-ts` installed at all — its node_modules holds exactly what the
 * eject told it to install — so any import of the package left anywhere fails loudly:
 *
 *   eject entity/queries/routes/routes-hono → gen → no generated or copied file imports
 *   the package → `tsc --init` + `tsc` over the whole project is clean → migrate → edit
 *   the LOCAL copy → boot the Fastify AND Hono routes on SQLite → CRUD, a filter and an
 *   error answer through the copy, carrying the edit → `verify --codegen` stays green →
 *   `meta gen --list` and `meta eject --list` report the edited copy as differing.
 */
import { describe, test, expect } from "bun:test";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { run } from "../../src/index.js";

// This package does not depend on hono, so the one surface the test drives is typed here.
interface HonoApp {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

const CLI_ROOT = resolve(import.meta.dirname, "..", "..");
const RUNTIME_ROOT = resolve(CLI_ROOT, "..", "runtime-ts");
const TSC = join(CLI_ROOT, "node_modules", "typescript", "bin", "tsc");
const RUNTIME_PKG = "@metaobjectsdev/runtime-ts";

// What the adopter installs — the eject's own install line — linked from this workspace's
// installs. `@metaobjectsdev/runtime-ts` is deliberately NOT among them.
const DEPS: ReadonlyArray<readonly [string, string]> = [
  ["@metaobjectsdev/codegen-ts", CLI_ROOT],
  ["@metaobjectsdev/metadata", CLI_ROOT],
  ["drizzle-orm", CLI_ROOT],
  ["fastify", CLI_ROOT],
  ["zod", CLI_ROOT],
  ["@libsql/client", CLI_ROOT],
  ["hono", RUNTIME_ROOT],
  ["qs", RUNTIME_ROOT],
  ["@types/qs", RUNTIME_ROOT],
];

const META = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Product",
          children: [
            { "source.rdb": { "@table": "products" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "name", "@required": true, "@maxLength": 200, "@filterable": true } },
            { "field.long": { name: "priceCents", "@filterable": true } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
    ],
  },
}, null, 2);

const CONFIG = `import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "./codegen/generators/entity.js";
import { queriesFile } from "./codegen/generators/queries.js";
import { routesFile } from "./codegen/generators/routes.js";
import { routesFileHono } from "./codegen/generators/routes-hono.js";

export default defineConfig({
  outDir: "src/gen",
  dialect: "sqlite",
  dbImport: "../db",
  extStyle: "js",
  generators: [entityFile(), queriesFile(), routesFile(), routesFileHono()],
});
`;

function scaffold(): { root: string; dbFile: string } {
  const root = mkdtempSync(join(tmpdir(), "mo-owned-runtime-"));
  const dbFile = join(root, "dev.sqlite");
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.shop.json"), META);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "owned-runtime-app", type: "module" }));
  writeFileSync(join(root, "metaobjects.config.ts"), CONFIG);
  writeFileSync(
    join(root, "src", "db.ts"),
    `import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
export const db = drizzle(createClient({ url: ${JSON.stringify(`file:${dbFile}`)} }));
`,
  );
  for (const [name, from] of DEPS) {
    const target = join(from, "node_modules", name);
    if (!existsSync(target)) throw new Error(`test setup: ${name} is not installed under ${from}`);
    const link = join(root, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, "dir");
  }
  return { root, dbFile };
}

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Module specifiers a file imports or re-exports. */
function importsOf(src: string): string[] {
  return [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"/g)].map((m) => m[1]!);
}

/** Capture what a CLI command logs. */
async function captured(argv: string[]): Promise<{ exit: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const exit = await run(argv);
    return { exit, out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("meta eject hands over the HTTP adapter source with the routes generators", () => {
  test("eject → gen → tsc → boot Fastify and Hono on SQLite, through the LOCAL copy", async () => {
    const { root, dbFile } = scaffold();
    try {
      // 1. Eject. The generators AND the adapter source their output imports.
      const ejected = await captured(["eject", "entity", "queries", "routes", "routes-hono", "--cwd", root]);
      expect(ejected.exit).toBe(0);
      for (const f of ["drizzle-fastify/index.ts", "drizzle-fastify/filter-parser.ts", "hono/index.ts", "route-errors.ts"]) {
        expect(existsSync(join(root, "codegen", "runtime", f))).toBe(true);
      }
      // The install line trades the runtime package for what the copy imports.
      expect(ejected.out).toContain("qs@");
      expect(ejected.out).not.toMatch(new RegExp(`${RUNTIME_PKG}@`));

      // 2. Generate.
      expect((await captured(["gen", "--cwd", root])).exit).toBe(0);
      const generated = tsFiles(join(root, "src", "gen"));
      expect(generated.map((f) => f.slice(root.length + 1)).sort()).toEqual([
        "src/gen/Product.queries.ts",
        "src/gen/Product.routes.hono.ts",
        "src/gen/Product.routes.ts",
        "src/gen/Product.ts",
      ]);

      // 3. Nothing the adopter now owns imports the runtime package — generated or copied.
      const owned = [...generated, ...tsFiles(join(root, "codegen", "runtime"))];
      for (const f of owned) {
        const offenders = importsOf(readFileSync(f, "utf8")).filter((s) => s.startsWith(RUNTIME_PKG));
        expect({ file: f.slice(root.length + 1), offenders }).toEqual({ file: f.slice(root.length + 1), offenders: [] });
      }
      const routesSrc = readFileSync(join(root, "src/gen/Product.routes.ts"), "utf8");
      expect(importsOf(routesSrc)).toContain("../../codegen/runtime/drizzle-fastify/index.js");
      expect(importsOf(readFileSync(join(root, "src/gen/Product.routes.hono.ts"), "utf8")))
        .toContain("../../codegen/runtime/hono/index.js");
      expect(importsOf(readFileSync(join(root, "src/gen/Product.ts"), "utf8")))
        .toContain("../../codegen/runtime/drizzle-fastify/filter-allowlist.js");

      // 4. Typecheck the whole project with exactly the options a fresh `tsc --init` writes.
      const init = spawnSync(process.execPath, [TSC, "--init"], { cwd: root, encoding: "utf8" });
      expect(init.status).toBe(0);
      const tsc = spawnSync(process.execPath, [TSC, "-p", ".", "--noEmit"], { cwd: root, encoding: "utf8" });
      expect(`${tsc.stdout}${tsc.stderr}`).toBe("");
      expect(tsc.status).toBe(0);

      // 5. Create the table.
      expect(
        (await captured([
          "migrate", "--cwd", root, "--from-db", "--db", `file:${dbFile}`, "--dialect", "sqlite", "--slug", "init", "--apply",
        ])).exit,
      ).toBe(0);

      // 6. Fix something in the LOCAL copy — the move ejecting exists to allow. Both adapters
      //    answer a failed body schema through this one envelope.
      const envelope = join(root, "codegen", "runtime", "route-errors.ts");
      const before = readFileSync(envelope, "utf8");
      const anchor = `export const ERROR_CODE_VALIDATION = "validation";`;
      expect(before).toContain(anchor);
      writeFileSync(envelope, before.replace(anchor, `export const ERROR_CODE_VALIDATION = "validation_owned";`));

      // 7. Boot both generated route sets and drive them.
      const { Product } = (await import(join(root, "src/gen/Product.ts"))) as { Product: { $path: string } };
      const { productRoutes } = (await import(join(root, "src/gen/Product.routes.ts"))) as {
        productRoutes: FastifyPluginAsync;
      };
      const { registerProductRoutes } = (await import(join(root, "src/gen/Product.routes.hono.ts"))) as {
        registerProductRoutes: (app: HonoApp, deps: { db: unknown }) => void;
      };
      const { db } = (await import(join(root, "src/db.ts"))) as { db: unknown };
      // The frameworks as the PROJECT resolves them, not as this test file would.
      const projectRequire = createRequire(join(root, "package.json"));
      const { default: Fastify } = (await import(projectRequire.resolve("fastify"))) as {
        default: typeof import("fastify").default;
      };
      const { Hono: HonoCtor } = (await import(projectRequire.resolve("hono"))) as {
        Hono: new () => HonoApp;
      };

      const fastify = Fastify();
      await fastify.register(productRoutes);
      await fastify.ready();
      const hono = new HonoCtor();
      registerProductRoutes(hono, { db });

      const path = Product.$path;
      const json = { "content-type": "application/json" };
      try {
        // CRUD over Fastify.
        const created = await fastify.inject({ method: "POST", url: path, headers: json, payload: { name: "Widget", priceCents: 500 } });
        expect(created.statusCode).toBe(201);
        const widget = created.json() as { id: number; name: string };
        expect(widget.name).toBe("Widget");
        const gadget = await fastify.inject({ method: "POST", url: path, headers: json, payload: { name: "Gadget", priceCents: 1500 } });
        expect(gadget.statusCode).toBe(201);

        const patched = await fastify.inject({ method: "PATCH", url: `${path}/${widget.id}`, headers: json, payload: { priceCents: 600 } });
        expect(patched.statusCode).toBe(200);
        expect((patched.json() as { priceCents: number }).priceCents).toBe(600);

        // A filter, parsed by the copied filter parser.
        const cheap = await fastify.inject({ method: "GET", url: `${path}?filter[priceCents][lt]=1000` });
        expect(cheap.statusCode).toBe(200);
        expect((cheap.json() as Array<{ name: string }>).map((r) => r.name)).toEqual(["Widget"]);
        const unknownField = await fastify.inject({ method: "GET", url: `${path}?filter[nope][eq]=1` });
        expect(unknownField.statusCode).toBe(400);

        // An error, answered by the EDITED copy.
        const invalid = await fastify.inject({ method: "POST", url: path, headers: json, payload: { name: "" } });
        expect(invalid.statusCode).toBe(400);
        expect((invalid.json() as { error: string }).error).toBe("validation_owned");

        // The same rows, and the same copy, over Hono.
        const listed = await hono.request(`${path}?filter[name][eq]=Gadget`);
        expect(listed.status).toBe(200);
        expect(((await listed.json()) as Array<{ priceCents: number }>).map((r) => r.priceCents)).toEqual([1500]);
        const got = await hono.request(`${path}/${widget.id}`);
        expect(got.status).toBe(200);
        const missing = await hono.request(`${path}/999999`);
        expect(missing.status).toBe(404);
        const honoInvalid = await hono.request(path, { method: "POST", headers: json, body: JSON.stringify({ name: "" }) });
        expect(honoInvalid.status).toBe(400);
        expect(((await honoInvalid.json()) as { error: string }).error).toBe("validation_owned");
        const removed = await hono.request(`${path}/${widget.id}`, { method: "DELETE" });
        expect(removed.status).toBe(204);
      } finally {
        await fastify.close();
      }

      // 8. The owned copy is not codegen drift: `meta gen` never wrote it.
      const verified = await captured(["verify", "--codegen", "--cwd", root]);
      expect(verified.exit).toBe(0);
      expect(verified.out).not.toContain("codegen/runtime");

      // 9. Both listings say the edited file now differs from the package, and name the diff.
      const genList = await captured(["gen", "--list", "--format", "text", "--cwd", root]);
      expect(genList.exit).toBe(0);
      expect(genList.out).toMatch(/routes\s.*owned runtime: 1 file\(s\) DIFFER/);
      const ejectList = await captured(["eject", "--list", "--format", "text", "--cwd", root]);
      expect(ejectList.out).toContain("codegen/runtime/route-errors.ts  [DIFFERS");
      expect(ejectList.out).toContain(`diff -u node_modules/${RUNTIME_PKG}/src/route-errors.ts codegen/runtime/route-errors.ts`);
      expect(ejectList.out).toContain("codegen/runtime/hono/index.ts  [identical to the package]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
