import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { FileSource } from "../src/loader/sources/file-source.js";
import { MetaDataLoader } from "../src/index.js";

describe("FileSource id", () => {
  test("defaults to the basename and accepts an explicit id that reaches node provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-id-"));
    const p = join(dir, "meta.a.json");
    await writeFile(p, JSON.stringify({ "metadata.root": { package: "p", children: [ { "object.value": { name: "V" } } ] } }));
    expect(new FileSource(p).id).toBe("meta.a.json");
    const src = new FileSource(p, { id: "dep:acme-common/acme-common.metaobjects.json" });
    expect(src.id).toBe("dep:acme-common/acme-common.metaobjects.json");
    const { root, errors } = await new MetaDataLoader().load([src]);
    expect(errors).toEqual([]);
    const v = root.objects()[0]!;
    expect("files" in v.source ? v.source.files : []).toEqual(["dep:acme-common/acme-common.metaobjects.json"]);
  });

  test("an explicit empty-string id is honoured, not treated as absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-id-empty-"));
    const p = join(dir, "meta.a.json");
    await writeFile(p, JSON.stringify({ "metadata.root": { package: "p", children: [] } }));
    expect(new FileSource(p, { id: "" }).id).toBe("");
  });
});
