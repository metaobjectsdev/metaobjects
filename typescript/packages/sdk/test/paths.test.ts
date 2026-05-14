import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recordPath, resolveMetaRoot } from "../src/paths.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "metaforge-paths-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("recordPath", () => {
  test("canonical path for decision record", () => {
    const meta = "/repo/.meta";
    expect(recordPath(meta, "decision", "decision-tanstack")).toBe(
      "/repo/.meta/memory/decision/decision-tanstack.json",
    );
  });
  test("pending path for entity record", () => {
    const meta = "/repo/.meta";
    expect(recordPath(meta, "entity", "entity-user", { pending: true })).toBe(
      "/repo/.meta/memory/_pending/entity/entity-user.json",
    );
  });
});

describe("resolveMetaRoot", () => {
  test("returns the .meta dir when start is the repo root", async () => {
    mkdirSync(resolve(tmp, ".meta"));
    expect(await resolveMetaRoot(tmp)).toBe(resolve(tmp, ".meta"));
  });
  test("walks up to find .meta from a nested dir", async () => {
    mkdirSync(resolve(tmp, ".meta"));
    mkdirSync(resolve(tmp, "src", "deep"), { recursive: true });
    expect(await resolveMetaRoot(resolve(tmp, "src", "deep"))).toBe(resolve(tmp, ".meta"));
  });
  test("throws when no .meta found", async () => {
    await expect(resolveMetaRoot(tmp)).rejects.toThrow(/no .meta/i);
  });
});
