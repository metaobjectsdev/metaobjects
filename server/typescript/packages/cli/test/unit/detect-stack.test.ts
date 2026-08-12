import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
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

  describe("requirements concern (observed, not a config flag)", () => {
    test("detects a requirement.* node in a nested metadata file", () => {
      const dir = tmp();
      try {
        const nested = join(dir, "metaobjects", "caps");
        mkdirSync(nested, { recursive: true });
        writeFileSync(
          join(nested, "meta.requirements.json"),
          JSON.stringify({
            "metadata.root": {
              package: "acme::caps",
              children: [{ "requirement.functional": { name: "Storefront", "@level": 1, "@status": "live" } }],
            },
          }),
        );
        const s = resolveStack(dir, { servers: [], clients: [] });
        expect(s.tokens.has("requirements")).toBe(true);
        expect(s.concerns).toEqual(["requirements"]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test("no requirements token for a project with no requirement.* nodes", () => {
      const dir = tmp();
      try {
        mkdirSync(join(dir, "metaobjects"), { recursive: true });
        writeFileSync(
          join(dir, "metaobjects", "meta.users.json"),
          JSON.stringify({ "metadata.root": { children: [{ "object.entity": { name: "User" } }] } }),
        );
        const s = resolveStack(dir, { servers: [], clients: [] });
        expect(s.tokens.has("requirements")).toBe(false);
        expect(s.concerns).toEqual([]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test("no metaobjects/ directory at all — treated as no requirements", () => {
      const dir = tmp();
      try {
        const s = resolveStack(dir, { servers: [], clients: [] });
        expect(s.tokens.has("requirements")).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test("survives an unreadable metadata subdirectory (defensive, no throw)", () => {
      const dir = tmp();
      try {
        const locked = join(dir, "metaobjects", "locked");
        mkdirSync(locked, { recursive: true });
        writeFileSync(join(locked, "meta.caps.json"), JSON.stringify({ "requirement.functional": { name: "X" } }));
        chmodSync(locked, 0o000);
        try {
          expect(() => resolveStack(dir, { servers: [], clients: [] })).not.toThrow();
          const s = resolveStack(dir, { servers: [], clients: [] });
          expect(s.tokens.has("requirements")).toBe(false);
        } finally {
          chmodSync(locked, 0o755); // restore so recursive cleanup below can descend into it
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test("concerns are observed independent of explicit --server/--client overrides", () => {
      const dir = tmp();
      try {
        const nested = join(dir, "metaobjects");
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(nested, "meta.caps.json"), JSON.stringify({ "requirement.architectural": { name: "X" } }));
        const s = resolveStack(dir, { servers: ["java"], clients: [] });
        expect(s.servers).toEqual(["java"]);
        expect(s.tokens.has("requirements")).toBe(true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
});
