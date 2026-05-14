import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../../src/commands/init.js";

describe("init scaffolds new layout (Task 11 contract)", () => {
  test("creates metaobjects/, .metaforge/, metaforge.config.ts — not legacy paths", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "g-init-layout-"));
    try {
      await init({ cwd: tmp, quiet: true });
      // New layout
      expect(existsSync(join(tmp, "metaobjects"))).toBe(true);
      expect(existsSync(join(tmp, "metaobjects", "meta.common.json"))).toBe(true);
      expect(existsSync(join(tmp, ".metaforge"))).toBe(true);
      expect(existsSync(join(tmp, ".metaforge", "config.json"))).toBe(true);
      expect(existsSync(join(tmp, ".metaforge", ".gen-state"))).toBe(true);
      expect(existsSync(join(tmp, "metaforge.config.ts"))).toBe(true);
      // Legacy layout must NOT be created
      expect(existsSync(join(tmp, ".meta"))).toBe(false);
      expect(existsSync(join(tmp, "forge.config.ts"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
