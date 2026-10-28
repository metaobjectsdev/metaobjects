// `meta eject --undo` takes back an ejected generator that never changed. A copy that is
// the shipped reference — byte for byte, or in the adopter's own formatting — freezes at the
// release it was copied from and misses every later fix, so a project that ejected during a
// period when the stock generators could not be imported keeps carrying it. Nothing used to
// notice. `meta gen` now says so, and `--undo` removes the copy.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ejectCommand, stockCopyNotice } from "../src/commands/eject.js";

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
  return mkdtempSync(join(tmpdir(), "meta-eject-undo-"));
}
const gen = (dir: string, name: string): string => join(dir, "codegen/generators", `${name}.ts`);
const text = (): string => [...logged, ...erred].join("\n");

describe("meta eject --undo", () => {
  test("with no names, removes every owned copy that is the shipped reference", async () => {
    const dir = tmp();
    try {
      expect(await ejectCommand(["entity", "queries"], dir, "text")).toBe(0);
      logged = []; erred = [];
      expect(await ejectCommand(["--undo"], dir, "text")).toBe(0);
      expect(existsSync(gen(dir, "entity"))).toBe(false);
      expect(existsSync(gen(dir, "queries"))).toBe(false);
      // Their copied template modules go with them, and the empty directories after.
      expect(existsSync(join(dir, "codegen/templates"))).toBe(false);
      expect(existsSync(join(dir, "codegen/generators"))).toBe(false);
      // The config is the adopter's: undo names the edit, it never makes it.
      expect(text()).toContain('import { entityFile } from "@metaobjectsdev/codegen-ts/generators"');
      expect(text()).toContain("metaobjects.config.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a copy in the adopter's own formatting still counts as the reference", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["barrel"], dir, "text");
      const file = gen(dir, "barrel");
      writeFileSync(file, readFileSync(file, "utf8").split("\n").map((l) => (/^\s*(import|export|const|return)\b.*;$/.test(l) ? `    ${l.slice(0, -1)}` : l)).join("\n"), "utf8");
      logged = []; erred = [];
      expect(await ejectCommand(["--undo"], dir, "text")).toBe(0);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no names, a customised copy is kept and said so", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["entity", "barrel"], dir, "text");
      writeFileSync(gen(dir, "barrel"), `${readFileSync(gen(dir, "barrel"), "utf8")}\n// MINE: a house rule\n`, "utf8");
      logged = []; erred = [];
      expect(await ejectCommand(["--undo"], dir, "text")).toBe(0);
      expect(existsSync(gen(dir, "entity"))).toBe(false);
      expect(existsSync(gen(dir, "barrel"))).toBe(true);
      expect(text()).toContain("barrel");
      expect(text()).toMatch(/kept|customi[sz]ed|differs/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("naming a customised copy refuses the whole call and removes nothing", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["entity", "barrel"], dir, "text");
      writeFileSync(gen(dir, "barrel"), `${readFileSync(gen(dir, "barrel"), "utf8")}\n// MINE\n`, "utf8");
      logged = []; erred = [];
      expect(await ejectCommand(["--undo", "entity", "barrel"], dir, "text")).toBe(2);
      expect(existsSync(gen(dir, "entity"))).toBe(true);
      expect(existsSync(gen(dir, "barrel"))).toBe(true);
      expect(text()).toContain("diff -u");
      expect(text()).toContain("--force");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--force removes a named customised copy", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["barrel"], dir, "text");
      writeFileSync(gen(dir, "barrel"), `${readFileSync(gen(dir, "barrel"), "utf8")}\n// MINE\n`, "utf8");
      logged = []; erred = [];
      expect(await ejectCommand(["--undo", "--force", "barrel"], dir, "text")).toBe(0);
      expect(existsSync(gen(dir, "barrel"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a template module another owned generator still reaches is kept", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["entity", "routes"], dir, "text");
      writeFileSync(gen(dir, "routes"), `${readFileSync(gen(dir, "routes"), "utf8")}\n// MINE\n`, "utf8");
      logged = []; erred = [];
      expect(await ejectCommand(["--undo"], dir, "text")).toBe(0);
      expect(existsSync(gen(dir, "entity"))).toBe(false);
      expect(existsSync(gen(dir, "routes"))).toBe(true);
      // routes still imports whatever it shares with entity, so those files stay.
      const imported = [...readFileSync(gen(dir, "routes"), "utf8").matchAll(/from "\.\.\/templates\/([^"]+)\.js"/g)];
      for (const m of imported) {
        expect(existsSync(join(dir, "codegen/templates", `${m[1]}.ts`)), m[1]).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a differing template module keeps its generator, which is reported", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["entity"], dir, "text");
      const tpl = readFileSync(gen(dir, "entity"), "utf8").match(/from "\.\.\/templates\/([^"]+)\.js"/)?.[1];
      expect(tpl).toBeDefined();
      const tplFile = join(dir, "codegen/templates", `${tpl}.ts`);
      writeFileSync(tplFile, `${readFileSync(tplFile, "utf8")}\n// MINE\n`, "utf8");
      logged = []; erred = [];
      expect(await ejectCommand(["--undo"], dir, "text")).toBe(0);
      expect(existsSync(gen(dir, "entity"))).toBe(true);
      expect(existsSync(tplFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("nothing identical: says so and changes nothing", async () => {
    const dir = tmp();
    try {
      expect(await ejectCommand(["--undo"], dir, "text")).toBe(0);
      expect(text()).toMatch(/nothing to undo|no owned/i);
      await ejectCommand(["barrel"], dir, "text");
      writeFileSync(gen(dir, "barrel"), `${readFileSync(gen(dir, "barrel"), "utf8")}\n// MINE\n`, "utf8");
      expect(await ejectCommand(["--undo"], dir, "text")).toBe(0);
      expect(existsSync(gen(dir, "barrel"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown name, or a name that is not a generator, refuses and removes nothing", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["barrel"], dir, "text");
      logged = []; erred = [];
      expect(await ejectCommand(["--undo", "barrel", "nope"], dir, "text")).toBe(2);
      expect(await ejectCommand(["--undo", "iam"], dir, "text")).toBe(2);
      expect(existsSync(gen(dir, "barrel"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a named generator that was never ejected is reported, not an error", async () => {
    const dir = tmp();
    try {
      expect(await ejectCommand(["--undo", "barrel"], dir, "text")).toBe(0);
      expect(text()).toMatch(/not ejected|nothing to undo/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--undo does not combine with --list", async () => {
    const dir = tmp();
    try {
      expect(await ejectCommand(["--undo", "--list"], dir, "text")).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the structured form lists what was undone and the import to restore", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["barrel"], dir, "text");
      logged = []; erred = [];
      expect(await ejectCommand(["--undo"], dir, "json")).toBe(0);
      const payload = JSON.parse(logged.join("\n")) as {
        undone: Array<{ name: string; path: string; wire: { import: string } }>;
        removed: string[];
      };
      expect(payload.undone.map((u) => u.name)).toEqual(["barrel"]);
      expect(payload.undone[0]?.wire.import).toContain("@metaobjectsdev/codegen-ts");
      expect(payload.removed).toContain("codegen/generators/barrel.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stockCopyNotice", () => {
  test("is undefined when the project owns no generator copy", async () => {
    const dir = tmp();
    try {
      expect(await stockCopyNotice(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("names the copies that are the shipped reference, and the command that removes them", async () => {
    const dir = tmp();
    try {
      await ejectCommand(["entity", "barrel"], dir, "text");
      writeFileSync(gen(dir, "barrel"), `${readFileSync(gen(dir, "barrel"), "utf8")}\n// MINE\n`, "utf8");
      const notice = await stockCopyNotice(dir);
      expect(notice).toContain("entity");
      expect(notice).not.toContain("barrel");
      expect(notice).toContain("meta eject --undo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
