import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStringSource } from "../../src/loader/meta-data-source.js";
import { FileSource } from "../../src/loader/sources/file-source.js";

describe("InMemoryStringSource", () => {
  it("read() resolves the content; id/format default", async () => {
    const s = new InMemoryStringSource('{"metadata.root":{}}');
    expect(s.format).toBe("json");
    expect(s.id).toBe("<inline>");
    expect(await s.read()).toBe('{"metadata.root":{}}');
  });

  it("honors an explicit id", async () => {
    const s = new InMemoryStringSource("x", { id: "fixture-a" });
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
    // Raw fs error — the exact text is platform-owned, so pin the stable fragment.
    await expect(s.read()).rejects.toThrow(/ENOENT|no such file/i);
  });
});
