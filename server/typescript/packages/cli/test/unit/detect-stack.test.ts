import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStack } from "../../src/lib/detect-stack.js";

function tmp(): string { return mkdtempSync(join(tmpdir(), "detect-")); }

const REQ = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [{ "requirement.functional": { name: "FR1", "@level": 1, "@status": "live" } }],
  },
});

describe("resolveStack", () => {
  test("explicit --server/--client overrides win over detection", async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@metaobjectsdev/react": "1" } }));
      const s = await resolveStack(dir, { servers: ["java", "kotlin"], clients: ["tanstack"] });
      expect(s.servers).toEqual(["java", "kotlin"]);
      expect(s.clients).toEqual(["tanstack"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("detects a TS server + react/tanstack from package.json deps", async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@metaobjectsdev/cli": "1", "@metaobjectsdev/react": "1", "@metaobjectsdev/tanstack": "1" } }));
      const s = await resolveStack(dir, { servers: [], clients: [] });
      expect(s.servers).toEqual(["typescript"]);
      expect(s.clients.sort()).toEqual(["react", "tanstack"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("detects a Java (Maven) server from pom.xml", async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "pom.xml"), "<project/>");
      const s = await resolveStack(dir, { servers: [], clients: [] });
      expect(s.servers).toEqual(["java"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  describe("requirements concern (observed, not a config flag)", () => {
    test("detects a requirement.* node in a nested metadata file", async () => {
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
        const s = await resolveStack(dir, { servers: [], clients: [] });
        expect(s.tokens.has("requirements")).toBe(true);
        expect(s.concerns).toEqual(["requirements"]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test("no requirements token for a project with no requirement.* nodes", async () => {
      const dir = tmp();
      try {
        mkdirSync(join(dir, "metaobjects"), { recursive: true });
        writeFileSync(
          join(dir, "metaobjects", "meta.users.json"),
          JSON.stringify({ "metadata.root": { children: [{ "object.entity": { name: "User" } }] } }),
        );
        const s = await resolveStack(dir, { servers: [], clients: [] });
        expect(s.tokens.has("requirements")).toBe(false);
        expect(s.concerns).toEqual([]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test("no metaobjects/ directory at all — treated as no requirements", async () => {
      const dir = tmp();
      try {
        const s = await resolveStack(dir, { servers: [], clients: [] });
        expect(s.tokens.has("requirements")).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test("survives an unreadable metadata subdirectory (defensive, no throw)", async () => {
      const dir = tmp();
      try {
        const locked = join(dir, "metaobjects", "locked");
        mkdirSync(locked, { recursive: true });
        writeFileSync(join(locked, "meta.caps.json"), JSON.stringify({ "requirement.functional": { name: "X" } }));
        chmodSync(locked, 0o000);
        try {
          const s = await resolveStack(dir, { servers: [], clients: [] });
          expect(s.tokens.has("requirements")).toBe(false);
        } finally {
          chmodSync(locked, 0o755); // restore so recursive cleanup below can descend into it
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test("concerns are observed independent of explicit --server/--client overrides", async () => {
      const dir = tmp();
      try {
        const nested = join(dir, "metaobjects");
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(nested, "meta.caps.json"), JSON.stringify({ "requirement.architectural": { name: "X" } }));
        const s = await resolveStack(dir, { servers: ["java"], clients: [] });
        expect(s.servers).toEqual(["java"]);
        expect(s.tokens.has("requirements")).toBe(true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test("finds requirement nodes in a sources-declared tree (no metaobjects/ at the start dir)", async () => {
      const dir = tmp();
      try {
        mkdirSync(join(dir, ".git"));
        mkdirSync(join(dir, "model"), { recursive: true });
        writeFileSync(join(dir, "model", "meta.req.json"), REQ);
        mkdirSync(join(dir, "apps", "ui", ".metaobjects"), { recursive: true });
        writeFileSync(
          join(dir, "apps", "ui", ".metaobjects", "config.json"),
          JSON.stringify({ schema_version: 1, sources: [{ path: "../../model" }] }),
        );
        const s = await resolveStack(join(dir, "apps", "ui"), { servers: [], clients: [] });
        expect(s.tokens.has("requirements")).toBe(true);
        expect(s.concerns).toContain("requirements");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test("finds requirement nodes behind a NESTED symlinked directory", async () => {
      const dir = tmp();
      try {
        mkdirSync(join(dir, ".git"));
        mkdirSync(join(dir, "real"), { recursive: true });
        writeFileSync(join(dir, "real", "meta.req.json"), REQ);
        mkdirSync(join(dir, "metaobjects"), { recursive: true });
        writeFileSync(join(dir, "metaobjects", "meta.a.json"), "{}");
        symlinkSync(join(dir, "real"), join(dir, "metaobjects", "linked"), "dir");
        const s = await resolveStack(dir, { servers: [], clients: [] });
        expect(s.tokens.has("requirements")).toBe(true);
        expect(s.concerns).toContain("requirements");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
});
