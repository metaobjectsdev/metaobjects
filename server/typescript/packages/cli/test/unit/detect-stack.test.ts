import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  test("the stack carries no requirements token: requirement.* nodes no longer gate what installs", async () => {
    // The requirements pages install in every stack. They used to be gated on a requirement
    // node observed at `meta init` time, before a new project had written one.
    const dir = tmp();
    try {
      mkdirSync(join(dir, "metaobjects"), { recursive: true });
      writeFileSync(join(dir, "metaobjects", "meta.req.json"), REQ);
      const s = await resolveStack(dir, { servers: [], clients: [] });
      expect(s.tokens.has("requirements")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
