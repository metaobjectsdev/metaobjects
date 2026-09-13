// `meta eject <name>...` — many names, one consolidated install set, one document.
//
// The single-name behaviour (preserve / differs / replace, and the three-branch wiring
// message) is covered by eject.test.ts and is unchanged. This file covers what taking
// several names at once adds, and the one failure mode it introduces.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ejectCommand } from "../src/commands/eject.js";
import { cliVersion } from "../src/lib/version.js";

let logged: string[];
let erred: string[];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logged = [];
  erred = [];
  console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { erred.push(a.join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "meta-eject-multi-"));
}

interface EjectPayload {
  ejected: Array<{
    name: string;
    path: string;
    status: string;
    wire: { import: string; entry: string };
    requires: string[];
  }>;
  install: { dev: string[]; runtime: string[]; command: string };
  config: { keys: string[] };
}

function payload(): EjectPayload {
  return JSON.parse(logged.join("\n")) as EjectPayload;
}

describe("meta eject takes many names", () => {
  test("ejects each one, in the order given", async () => {
    const dir = tmp();
    try {
      expect(await ejectCommand(["entity", "queries", "routes"], dir, "text")).toBe(0);
      for (const n of ["entity", "queries", "routes"]) {
        expect(existsSync(join(dir, "codegen/generators", `${n}.ts`)), n).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown name refuses the WHOLE call and copies nothing", async () => {
    // A partial eject is the worst outcome available: a non-zero exit over a repo that
    // is half-changed, where re-running the fixed command reports the already-copied
    // half as "preserved" and the adopter cannot tell what happened.
    const dir = tmp();
    try {
      expect(await ejectCommand(["entity", "nonesuch"], dir, "text")).toBe(2);
      expect(existsSync(join(dir, "codegen/generators/entity.ts"))).toBe(false);
      expect(erred.join("\n")).toContain("Nothing was ejected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a repeated name is a usage error, not a silent second write", async () => {
    const dir = tmp();
    try {
      expect(await ejectCommand(["entity", "entity"], dir, "text")).toBe(2);
      expect(erred.join("\n")).toContain("repeated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no names at all points at the catalog rather than just refusing", async () => {
    const dir = tmp();
    try {
      expect(await ejectCommand([], dir, "text")).toBe(2);
      expect(erred.join("\n")).toContain("meta gen --list");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("--format json", () => {
  test("emits ONE document with the wire lines per file", async () => {
    const dir = tmp();
    try {
      expect(await ejectCommand(["hooks"], dir, "json")).toBe(0);
      const p = payload();
      expect(p.ejected.length).toBe(1);
      expect(p.ejected[0]!.name).toBe("hooks");
      expect(p.ejected[0]!.status).toBe("created");
      // The exported symbol does NOT follow the file name — hooks.ts exports
      // tanstackQuery — so the entry is read from the template's own header.
      expect(p.ejected[0]!.wire.entry).toBe("tanstackQuery()");
      expect(p.ejected[0]!.wire.import).toContain("./codegen/generators/hooks.js");
      expect(p.ejected[0]!.requires).toContain("entity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the install set is CONSOLIDATED, not per name", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["hooks", "grid"], dir, "json");
      const p = payload();
      const tanstack = p.install.dev.filter((d) =>
        d.startsWith("@metaobjectsdev/codegen-ts-tanstack@"));
      expect(tanstack.length, "the shared codegen package appears once").toBe(1);
      expect(tanstack[0]).toBe(`@metaobjectsdev/codegen-ts-tanstack@^${cliVersion()}`);
      // Both generators' third-party peers, unioned.
      expect(p.install.runtime.some((r) => r.startsWith("@tanstack/react-query"))).toBe(true);
      expect(p.install.runtime.some((r) => r.startsWith("@tanstack/react-table"))).toBe(true);
      expect(p.install.command).toContain("npm i -D");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("third-party ranges come from the runtime package's own peerDependencies", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["routes"], dir, "json");
      const p = payload();
      const fastify = p.install.runtime.find((r) => r.startsWith("fastify"));
      // A RANGE, not a bare name and not the CLI's version: read off
      // @metaobjectsdev/runtime-ts, which is what routes' emitted code imports.
      expect(fastify, "fastify is in the runtime install set").toBeDefined();
      expect(fastify).toContain("@");
      expect(fastify).not.toBe(`fastify@^${cliVersion()}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports the config keys the ejected generators read", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["routes"], dir, "json");
      expect(payload().config.keys).toContain("dbImport");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("nothing but the document reaches stdout", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["entity"], dir, "json");
      // Would throw on any prose line — the `meta types` stdout-purity rule.
      expect(() => JSON.parse(logged.join("\n"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("text output", () => {
  test("names the requires edges the selection does not itself satisfy", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["grid-hook"], dir, "text");
      const out = logged.join("\n");
      expect(out).toContain("Also needed:");
      for (const dep of ["entity", "grid", "hooks"]) {
        expect(out, `names "${dep}"`).toContain(dep);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("says nothing about requires once the selection covers them", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["entity", "grid", "hooks", "grid-hook"], dir, "text");
      expect(logged.join("\n")).not.toContain("Also needed:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("still never clobbers an owned copy without --force", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["entity"], dir, "text");
      const owned = join(dir, "codegen/generators/entity.ts");
      writeFileSync(owned, "// mine\n");
      await ejectCommand(["entity", "queries"], dir, "text");
      expect(readFileSync(owned, "utf8")).toBe("// mine\n");
      // ...and the OTHER name in the same call still landed.
      expect(existsSync(join(dir, "codegen/generators/queries.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
