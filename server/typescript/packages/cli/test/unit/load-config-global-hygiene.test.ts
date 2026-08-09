// Global-state hygiene at the config-loader seam.
//
// Loading a `metaobjects.config.ts` must not mutate `Error.prepareStackTrace`.
// Under Bun, when native import of the config fails, jiti falls back to its bundled
// Babel transformer, whose rewrite-stack-trace permanently installs a
// `prepareStackTrace` wrapper delegating to the value it captured. On Node that value
// is `undefined` (harmless); on Bun it is Bun's NATIVE default, which throws
// `TypeError: First argument must be an Error object` for anything that is not a real
// ErrorInstance. Once leaked, every later legacy-constructor error in the process
// throws that TypeError *while being constructed* — libsql's `SqliteError` is exactly
// that shape, so a real "CHECK constraint failed" became the TypeError instead.
//
// The observable damage: in any workspace-wide `bun test`, four migrate-ts real-engine
// gates failed on their error-MESSAGE assertions while the engine was working
// correctly. Every CI lane runs `bun test` per package, so `cli` and `migrate-ts` never
// shared a process and the leak was invisible.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMetaobjectsConfig } from "../../src/lib/load-metaobjects-config.js";

describe("loadMetaobjectsConfig — global hooks hygiene", () => {
  test("a throwing config surfaces its error AND leaves Error.prepareStackTrace untouched", async () => {
    const before = Error.prepareStackTrace;
    const dir = mkdtempSync(join(tmpdir(), "meta-config-hygiene-"));
    try {
      writeFileSync(join(dir, "metaobjects.config.ts"), "throw new Error('broken config boom');\n");
      // The failure must still be reported — the fix restores a hook, it does not swallow.
      await expect(loadMetaobjectsConfig(dir)).rejects.toThrow(/broken config boom/);
      expect(Error.prepareStackTrace).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a legacy-constructor error still carries its own message after a failed config load", async () => {
    // The end-to-end consequence, independent of the hook identity above: this is the
    // exact shape of libsql's SqliteError (ES5 constructor + Error.captureStackTrace).
    const dir = mkdtempSync(join(tmpdir(), "meta-config-hygiene-legacy-"));
    try {
      writeFileSync(join(dir, "metaobjects.config.ts"), "throw new Error('broken config boom');\n");
      await expect(loadMetaobjectsConfig(dir)).rejects.toThrow(/broken config boom/);

      function LegacyError(this: Record<string, unknown>, msg: string) {
        this["message"] = msg;
        Error.captureStackTrace(this, LegacyError);
      }
      LegacyError.prototype = Object.create(Error.prototype);

      const constructed = new (LegacyError as unknown as new (m: string) => { message: string })(
        "CHECK constraint failed: things",
      );
      expect(constructed.message).toMatch(/CHECK constraint failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
