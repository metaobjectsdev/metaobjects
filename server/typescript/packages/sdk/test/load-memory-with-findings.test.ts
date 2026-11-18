// `meta gen` loads leniently and names the unknown attributes a strict load would refuse.
// It used to load the model three times to do that (the lenient load, then a strict and a
// lenient one for the findings); `loadMemoryWithFindings` answers both from one load, and
// parses strictly again only when the model holds an unknown bare key.
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { loadMemoryWithFindings } from "../src/memory.js";

function model(opts: { bareKey?: boolean; attr?: boolean }): string {
  return JSON.stringify({
    "metadata.root": {
      package: "app",
      children: [
        {
          "object.entity": {
            name: "BaseThing",
            ...(opts.bareKey === true ? { isAbstrakt: true } : { abstract: true }),
            children: [{ "field.long": { name: "id" } }],
          },
        },
        {
          "object.entity": {
            name: "Talk",
            extends: "BaseThing",
            children: [
              { "source.rdb": { "@table": "talks" } },
              { "field.string": { name: "title", ...(opts.attr === true ? { "@requird": true } : { "@required": true }) } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
      ],
    },
  });
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sdk-load-findings-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function load(opts: { bareKey?: boolean; attr?: boolean }, strict = false) {
  writeFileSync(join(root, "metaobjects", "meta.app.json"), model(opts));
  const spy = spyOn(MetaDataLoader.prototype, "load");
  try {
    const result = await loadMemoryWithFindings(root, strict ? { strict: true } : undefined);
    return { ...result, loads: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

describe("loadMemoryWithFindings", () => {
  test("a clean model loads once and has no findings", async () => {
    const r = await load({});
    expect(r.loads).toBe(1);
    expect(r.unknownAttributes).toEqual([]);
    expect(r.root.objects().map((o) => o.name).sort()).toEqual(["BaseThing", "Talk"]);
  });

  test("an unknown @attr is found from the same load, with its file", async () => {
    const r = await load({ attr: true });
    expect(r.loads).toBe(1);
    expect(r.unknownAttributes).toHaveLength(1);
    expect(r.unknownAttributes[0]!.message).toContain("@requird");
    expect(JSON.stringify(r.unknownAttributes[0]!.source)).toContain("meta.app.json");
  });

  test("an unknown bare key costs one strict parse more, which locates it", async () => {
    const r = await load({ bareKey: true, attr: true });
    expect(r.loads).toBe(2);
    const messages = r.unknownAttributes.map((f) => f.message);
    expect(messages.some((m) => m.includes("isAbstrakt"))).toBe(true);
    expect(messages.some((m) => m.includes("@requird"))).toBe(true);
    for (const f of r.unknownAttributes) expect(JSON.stringify(f.source)).toContain("meta.app.json");
  });

  test("a strict load reports nothing: it refuses the first finding instead", async () => {
    await expect(load({ attr: true }, true)).rejects.toThrow(/@requird/);
    const clean = await load({}, true);
    expect(clean.loads).toBe(1);
    expect(clean.unknownAttributes).toEqual([]);
  });
});
