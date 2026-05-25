import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectorySource, FileSource, UriSource } from "../../src/loader/sources/index.js";
import { InMemoryStringSource } from "../../src/loader/meta-data-source.js";

describe("InMemoryStringSource", () => {
  test("defaults: id is '<inline>', format is 'json'", async () => {
    const s = new InMemoryStringSource("{}");
    expect(s.id).toBe("<inline>");
    expect(s.format).toBe("json");
    expect(await s.read()).toBe("{}");
  });

  test("explicit id", () => {
    const s = new InMemoryStringSource("x", { id: "fixture-a" });
    expect(s.id).toBe("fixture-a");
  });

  test("explicit yaml format", () => {
    const s = new InMemoryStringSource("x: 1", { format: "yaml" });
    expect(s.format).toBe("yaml");
  });
});

describe("FileSource", () => {
  test("infers format from extension; id is basename", () => {
    expect(new FileSource("/tmp/meta.commerce.json").format).toBe("json");
    expect(new FileSource("/tmp/meta.commerce.yaml").format).toBe("yaml");
    expect(new FileSource("/tmp/meta.commerce.yml").format).toBe("yaml");
    expect(new FileSource("/tmp/meta.commerce.json").id).toBe("meta.commerce.json");
  });
});

describe("DirectorySource", () => {
  test("expand sorts by basename and filters by supported extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ds-"));
    try {
      await writeFile(join(dir, "b.json"), "{}");
      await writeFile(join(dir, "a.yaml"), "");
      await writeFile(join(dir, "skip.txt"), "x");
      const expanded = await new DirectorySource(dir).expand();
      // FileSource.id is the basename, so ordinal sort by basename:
      // "a.yaml" < "b.json".
      expect(expanded.map((s) => s.id)).toEqual(["a.yaml", "b.json"]);
      expect(expanded[0]!.format).toBe("yaml");
      expect(expanded[1]!.format).toBe("json");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("honors exclude (literal filename)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ds-"));
    try {
      await writeFile(join(dir, "meta.alpha.json"), "{}");
      await writeFile(join(dir, "meta.beta.json"), "{}");
      const expanded = await new DirectorySource(dir, {
        exclude: ["meta.beta.json"],
      }).expand();
      expect(expanded.map((s) => s.id)).toEqual(["meta.alpha.json"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("honors exclude (glob)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ds-"));
    try {
      await writeFile(join(dir, "meta.alpha.json"), "{}");
      await writeFile(join(dir, "meta.beta.json"), "{}");
      const expanded = await new DirectorySource(dir, {
        exclude: ["meta.beta.*"],
      }).expand();
      expect(expanded.map((s) => s.id)).toEqual(["meta.alpha.json"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("recurses by default into subdirectories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ds-"));
    try {
      await writeFile(join(dir, "a.json"), "{}");
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "sub", "b.json"), "{}");
      const expanded = await new DirectorySource(dir).expand();
      expect(expanded.map((s) => s.id).sort()).toEqual(["a.json", "b.json"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("recurse: false ignores subdirectories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ds-"));
    try {
      await writeFile(join(dir, "a.json"), "{}");
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "sub", "b.json"), "{}");
      const expanded = await new DirectorySource(dir, { recurse: false }).expand();
      expect(expanded.map((s) => s.id)).toEqual(["a.json"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("non-existent directory throws on expand()", async () => {
    const src = new DirectorySource("/does/not/exist/__ds__");
    await expect(src.expand()).rejects.toThrow(/cannot read/);
  });
});

describe("UriSource", () => {
  test("infers format from extension; id is the URI string", () => {
    expect(new UriSource("file:///tmp/x.json").format).toBe("json");
    expect(new UriSource("file:///tmp/x.yaml").format).toBe("yaml");
    expect(new UriSource("https://example.com/x.yml").format).toBe("yaml");
    expect(new UriSource("file:///tmp/x.json").id).toBe("file:///tmp/x.json");
  });

  test("explicit format overrides inference", () => {
    expect(new UriSource("file:///tmp/x.txt", "yaml").format).toBe("yaml");
  });

  test("file:// reads local file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "us-"));
    try {
      const p = join(dir, "x.json");
      await writeFile(p, '{"metadata.root":{}}');
      const src = new UriSource("file://" + p);
      expect(await src.read()).toBe('{"metadata.root":{}}');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("unsupported scheme rejects", async () => {
    const src = new UriSource("ftp://example.com/x.json");
    await expect(src.read()).rejects.toThrow(/unsupported scheme/);
  });
});
