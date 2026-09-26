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

  test("a package-only generator is named as such, not as unknown", async () => {
    // `callable` is a real catalog entry with no reference template. Calling it
    // "unknown" sends the reader looking for a typo that is not there.
    const dir = tmp();
    try {
      expect(await ejectCommand(["callable"], dir, "text")).toBe(2);
      const err = erred.join("\n");
      expect(err).toContain("package-only");
      expect(err).toContain("callable");
      expect(err).not.toContain("unknown name(s): callable");
      expect(err).toContain("@metaobjectsdev/codegen-ts");
      expect(err).toContain("Nothing was ejected");
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

// Each ejected file printed its own install line naming `@metaobjectsdev/metadata` (the
// reference templates import it at gen time), while the consolidated summary — built
// from the catalog alone — left it out, so an adopter who ran only the summary line got
// TS2307 on the files they had just been told they own.
describe("the install summary is the union of the per-generator lines", () => {
  function devSpecsIn(line: string): string[] {
    const m = /npm i -D ([^&]+)/.exec(line);
    return m === null ? [] : m[1]!.trim().split(/\s+/);
  }
  function runtimeSpecsIn(line: string): string[] {
    const m = /(?:^|&& )npm i (?!-D)(.+)$/.exec(line.trim());
    return m === null ? [] : m[1]!.trim().split(/\s+/);
  }

  test("text: every package a per-file line names is in the summary line", async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", type: "module" }));
      expect(await ejectCommand(["entity", "queries", "routes"], dir, "text")).toBe(0);
      const idx = logged.findIndex((l) => l.includes("Install what the ejected generators"));
      expect(idx).toBeGreaterThan(-1);
      const summary = logged[idx + 1]!;
      const perFile = logged.slice(0, idx).filter((l) => l.trim().startsWith("npm i -D"));
      expect(perFile.length).toBeGreaterThan(0);
      // Either half of the summary satisfies a per-file line: since the entity and routes
      // generators also hand over the adapter source (ADR-0034 Amendment 3), whose copy
      // imports `@metaobjectsdev/metadata` at RUNTIME, that package moves to the `npm i`
      // half — which installs it for the build as well.
      const summarySpecs = new Set([...devSpecsIn(summary), ...runtimeSpecsIn(summary)]);
      for (const spec of perFile.flatMap(devSpecsIn)) {
        expect(summarySpecs.has(spec), `summary names ${spec}`).toBe(true);
      }
      expect(summarySpecs.has(`@metaobjectsdev/metadata@^${cliVersion()}`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("json: install.dev carries the packages the ejected templates import", async () => {
    const dir = tmp();
    try {
      expect(await ejectCommand(["entity"], dir, "json")).toBe(0);
      // `entity` also hands over the allowlist-type source, which imports the core
      // `@metaobjectsdev/metadata` at runtime — so it lands in the runtime half.
      const { dev, runtime } = payload().install;
      expect([...dev, ...runtime]).toContain(`@metaobjectsdev/metadata@^${cliVersion()}`);
      expect(dev).toContain(`@metaobjectsdev/codegen-ts@^${cliVersion()}`);
      // ...and the generated entity module no longer needs the runtime package at all.
      expect(runtime.some((s: string) => s.startsWith("@metaobjectsdev/runtime-ts@"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
