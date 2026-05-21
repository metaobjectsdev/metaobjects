import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySource } from "../../src/loader/meta-data-source.js";
import { FileSource } from "../../src/core/file-source.js";

describe("InMemorySource", () => {
  it("read() resolves the content; id/format default", async () => {
    const s = new InMemorySource('{"metadata.root":{}}');
    expect(s.format).toBe("json");
    expect(s.id).toBe("<in-memory>");
    expect(await s.read()).toBe('{"metadata.root":{}}');
  });

  it("honors an explicit id", async () => {
    const s = new InMemorySource("x", { id: "fixture-a" });
    expect(s.id).toBe("fixture-a");
  });
});

describe("FileSource", () => {
  it("read() returns file content; id is the basename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mds-"));
    try {
      const p = join(dir, "meta.users.json");
      writeFileSync(p, '{"metadata.root":{}}');
      const s = new FileSource(p);
      expect(s.id).toBe("meta.users.json");
      expect(s.format).toBe("json");
      expect(s.path).toBe(p);
      expect(await s.read()).toBe('{"metadata.root":{}}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("read() rejects for a missing file", async () => {
    const s = new FileSource("/no/such/file.json");
    await expect(s.read()).rejects.toThrow();
  });
});
