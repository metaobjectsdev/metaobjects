import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStack } from "../../src/lib/detect-stack.js";

function tmp(): string { return mkdtempSync(join(tmpdir(), "detect-")); }

describe("resolveStack", () => {
  test("explicit --server/--client overrides win over detection", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@metaobjectsdev/react": "1" } }));
      const s = resolveStack(dir, { servers: ["java", "kotlin"], clients: ["tanstack"] });
      expect(s.servers).toEqual(["java", "kotlin"]);
      expect(s.clients).toEqual(["tanstack"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("detects a TS server + react/tanstack from package.json deps", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@metaobjectsdev/cli": "1", "@metaobjectsdev/react": "1", "@metaobjectsdev/tanstack": "1" } }));
      const s = resolveStack(dir, { servers: [], clients: [] });
      expect(s.servers).toEqual(["typescript"]);
      expect(s.clients.sort()).toEqual(["react", "tanstack"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("detects a Java (Maven) server from pom.xml", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "pom.xml"), "<project/>");
      const s = resolveStack(dir, { servers: [], clients: [] });
      expect(s.servers).toEqual(["java"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
