// FR-040 §6.4 — the `clientDirective` config knob.
//
// The knob exists because the generated form/hook/grid modules ARE client components,
// but only a framework that compiles server and client from one tree (React Server
// Components) REQUIRES the directive saying so. It is a fact about the adopter's
// bundler topology, which the metamodel cannot derive — hence config, defaulted off.
//
// Two properties matter and both are asserted here: OFF must be byte-identical to
// before the knob existed (otherwise every project that never opts in pays for it),
// and ON must put the directive where a bundler will actually honour it — first token
// of the module, ahead of the `@generated` header, exactly once.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, queriesFile } from "@metaobjectsdev/codegen-ts/generators";
import { tanstackQuery, tanstackGrid, tanstackGridHook } from "../src/index.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "fixtures", "multi-grid-entity.json");

async function gen(clientDirective: boolean | undefined): Promise<Record<string, string>> {
  const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  const dir = mkdtempSync(join(tmpdir(), "client-directive-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: dir, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        ...(clientDirective === undefined ? {} : { clientDirective }),
        generators: [entityFile(), queriesFile(), tanstackQuery(), tanstackGrid(), tanstackGridHook()],
      }),
      metadata: root,
    });
    const out: Record<string, string> = {};
    for (const f of readdirSync(dir)) out[f] = readFileSync(join(dir, f), "utf-8");
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The generated modules that are actually client components. */
const CLIENT_ARTIFACTS = [".hooks.ts", ".columns.tsx", ".grid.ts"];
const isClientArtifact = (f: string): boolean => CLIENT_ARTIFACTS.some((s) => f.endsWith(s));

describe("clientDirective", () => {
  test("omitted is byte-identical to explicitly false", async () => {
    expect(await gen(undefined)).toEqual(await gen(false));
  });

  test("off emits no directive anywhere", async () => {
    for (const [name, body] of Object.entries(await gen(false))) {
      expect({ name, hasDirective: body.includes("use client") })
        .toEqual({ name, hasDirective: false });
    }
  });

  test("on puts it first in every client artifact, exactly once", async () => {
    const files = await gen(true);
    const clients = Object.keys(files).filter(isClientArtifact);
    // Guard against the assertion below going vacuous if the fixture stops emitting.
    expect(clients.length).toBeGreaterThan(0);

    for (const name of clients) {
      const body = files[name] as string;
      // FIRST token — ahead of the @generated header. A directive prologue is only
      // honoured before any other statement, and some bundlers want it before the
      // leading comment too.
      expect({ name, head: body.slice(0, 13) }).toEqual({ name, head: '"use client";' });
      expect({ name, count: body.split("use client").length - 1 }).toEqual({ name, count: 1 });
    }
  });

  test("on leaves non-client modules untouched", async () => {
    const on = await gen(true);
    const off = await gen(false);
    for (const name of Object.keys(off).filter((f) => !isClientArtifact(f))) {
      // The entity module, queries, and the `.meta.ts` descriptor are NOT client
      // components: `.meta.ts` is plain data imported BY a client component, and in
      // RSC the boundary is the importing component, not everything it reaches.
      expect({ name, body: on[name] }).toEqual({ name, body: off[name] });
    }
  });
});
