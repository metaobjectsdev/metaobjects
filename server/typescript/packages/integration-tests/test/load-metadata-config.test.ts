// A corpus's `.metaobjects/config.json` reaches the loaded root the way a project load does:
// naming, wire format and enum defaults, so the schema a lane builds is the one the corpus pins.
import { test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEnumMaxLength } from "@metaobjectsdev/metadata";
import { loadMetadataDir } from "../src/load-metadata.ts";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

test("enums.maxLength from the corpus config sizes an enum without its own @maxLength", async () => {
  const dir = await mkdtemp(join(tmpdir(), "it-load-config-"));
  dirs.push(dir);
  await mkdir(join(dir, ".metaobjects"));
  await writeFile(join(dir, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, enums: { maxLength: 40 } }));
  await mkdir(join(dir, "meta"));
  await writeFile(join(dir, "meta", "meta.json"), JSON.stringify({ "metadata.root": { package: "p", children: [
    { "object.entity": { name: "Ticket", children: [
      { "source.rdb": { "@table": "tickets" } },
      { "field.long": { name: "id" } },
      { "field.enum": { name: "state", "@values": ["OPEN", "CLOSED"] } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
    ] } },
  ] } }));
  const root = await loadMetadataDir(join(dir, "meta"));
  const state = root.findObject("Ticket")!.fields().find((f) => f.name === "state")!;
  expect(resolveEnumMaxLength(state)).toBe(40);
});
