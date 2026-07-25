/**
 * Quickstart smoke gate — the documented TS first-touch path, end to end.
 *
 * `docs/ports/typescript.md` tells a newcomer to author metadata, run `meta gen`,
 * run `meta migrate ... --apply`, boot Fastify with the generated routes plugin,
 * and then prove it with three curl calls. Every one of those steps has broken at
 * least once (the 0.20.0/0.20.1 line fixed a greenfield `migrate baseline` trap
 * and a nodenext import-extension break, both found by hand, both invisible to
 * the unit suites because no test ever ran the sequence as a user runs it).
 *
 * This runs the sequence: gen -> migrate --apply -> boot the GENERATED routes over
 * real HTTP against a real SQLite file -> assert the wire behaviour the doc claims
 * (201 on create, 200 + row on read, 400 on a `@required` violation, 200 on patch,
 * 204 on delete). If the documented quickstart rots, this goes red.
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { run } from "../../src/index.js";

// Temp roots live inside the monorepo so the generated code and the config can
// resolve workspace packages (jiti loads metaobjects.config.ts from here).
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

// The exact entity the quickstart tells the reader to author.
const META = JSON.stringify(
  {
    "metadata.root": {
      package: "acme::blog",
      children: [
        {
          "object.entity": {
            name: "Author",
            children: [
              { "source.rdb": { "@table": "authors" } },
              { "field.long": { name: "id" } },
              { "field.string": { name: "name", "@required": true, "@maxLength": 200 } },
              { "field.string": { name: "bio", "@maxLength": 2000 } },
              { "identity.primary": { "@fields": "id", "@generation": "increment" } },
            ],
          },
        },
      ],
    },
  },
  null,
  2,
);

function scaffold(): { root: string; outDir: string; dbFile: string } {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "quickstart-smoke-"));
  const outDir = join(root, "generated");
  const dbFile = join(root, "dev.sqlite");

  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.blog.json"), META);
  mkdirSync(outDir, { recursive: true });

  // The db singleton the generated code imports, exactly as the quickstart's
  // src/db.ts does. It sits beside the generated files so `./db` resolves.
  writeFileSync(
    join(outDir, "db.ts"),
    `import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
export const db = drizzle(createClient({ url: ${JSON.stringify(`file:${dbFile}`)} }));
`,
  );

  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, queriesFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(outDir)},
  dialect: "sqlite",
  dbImport: "./db",
  extStyle: "js",
  generators: [entityFile(), queriesFile(), routesFile()],
});
`,
  );
  return { root, outDir, dbFile };
}

describe("quickstart smoke — the documented TS path, gen -> migrate -> boot -> HTTP", () => {
  test("a newcomer following docs/ports/typescript.md gets a working API", async () => {
    const { root, outDir, dbFile } = scaffold();
    // Registered lazily so a failure before boot still tears down cleanly.
    let close: (() => Promise<void>) | undefined;
    try {
      // 1. meta gen
      expect(await run(["gen", "--cwd", root])).toBe(0);

      // 2. meta migrate --from-db ... --apply (the greenfield path the 0.20.1
      //    line fixed; `baseline` on an empty DB is the trap it must not be)
      expect(
        await run([
          "migrate",
          "--cwd", root,
          "--from-db",
          "--db", `file:${dbFile}`,
          "--dialect", "sqlite",
          "--slug", "init",
          "--apply",
        ]),
      ).toBe(0);

      // 3. boot the GENERATED routes plugin on Fastify, as the doc shows
      const { default: Fastify } = await import("fastify");
      // The routes module is generated at runtime, so its type isn't knowable at
      // compile time — register through Fastify's own plugin type.
      const { authorRoutes } = (await import(join(outDir, "Author.routes.ts"))) as {
        authorRoutes: FastifyPluginAsync;
      };
      const app = Fastify();
      await app.register(authorRoutes);
      await app.listen({ port: 0, host: "127.0.0.1" });
      close = async () => {
        await app.close();
      };
      const addr = app.server.address();
      if (!addr || typeof addr === "string") throw new Error("no bound port");
      const base = `http://127.0.0.1:${addr.port}`;
      const json = { "content-type": "application/json" };

      // 4. create -> 201 with the persisted row
      const created = await fetch(`${base}/authors`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name: "Ada Lovelace" }),
      });
      expect(created.status).toBe(201);
      const row = (await created.json()) as { id: number; name: string };
      expect(row.name).toBe("Ada Lovelace");
      expect(typeof row.id).toBe("number");

      // 5. read it back -> 200 and the row is there
      const listed = await fetch(`${base}/authors`);
      expect(listed.status).toBe(200);
      // A bare array — the `{ data, count }` envelope is opt-in via ?withCount=1,
      // which is what the quickstart's "a JSON array containing the row" claims.
      const rows = (await listed.json()) as unknown[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(1);

      // 6. violate the declared @required -> 400, NOT a 500. This is the claim
      //    the quickstart makes: metadata became real wire-tier validation.
      const rejected = await fetch(`${base}/authors`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name: "" }),
      });
      expect(rejected.status).toBe(400);

      // 7. patch -> 200 and the change stuck
      const patched = await fetch(`${base}/authors/${row.id}`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ bio: "First programmer" }),
      });
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as { bio: string }).bio).toBe("First programmer");

      // 8. delete -> 204
      const deleted = await fetch(`${base}/authors/${row.id}`, { method: "DELETE" });
      expect(deleted.status).toBe(204);
    } finally {
      await close?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
