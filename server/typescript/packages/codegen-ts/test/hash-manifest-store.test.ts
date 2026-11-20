// ADR-0064 Amendment 1: the hash manifest is one file per model package. The vectors are the
// shared ones every port runs (`fixtures/codegen-skip-conformance/manifests.json`).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildPlacementIndex,
  manifestFileName,
  placeEntry,
  readManifestState,
} from "../src/hash-manifest-store.js";
import { forgetGeneratedPaths, listGeneratedPaths, withManifestBatch, writeManifestFiles } from "../src/overwrite-policy.js";

interface Vectors {
  objects: { name: string; package: string }[];
  fileNames: { package: string | null; file: string }[];
  placement: { path: string; package: string | null; entry?: unknown }[];
  legacySplit: {
    legacy: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
    goldenFile: string;
    goldenText: string;
    gitignoreBefore: string;
    gitignoreAfter: string;
  };
}

const VECTORS = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../../../../fixtures/codegen-skip-conformance/manifests.json"), "utf-8"),
) as Vectors;
const INDEX = buildPlacementIndex(VECTORS.objects);

let tmp: string;
let state: string;
beforeEach(() => {
  tmp = mkdtempSync(join(process.env.DEV_SCRATCH ?? "/tmp", "hash-manifest-store-"));
  state = join(tmp, ".metaobjects", ".gen-state");
  mkdirSync(state, { recursive: true });
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const dirOf = (): string => join(state, ".hashes");
const files = (): string[] => (existsSync(dirOf()) ? readdirSync(dirOf()).sort() : []);
const read = (name: string): unknown => JSON.parse(readFileSync(join(dirOf(), name), "utf-8"));
const save = (entries: Record<string, unknown>, index = INDEX): void => {
  writeManifestFiles(state, entries, readManifestState(state), index);
};

describe("shared vectors", () => {
  test("file names", () => {
    for (const v of VECTORS.fileNames) expect(manifestFileName(v.package)).toBe(v.file);
  });

  test("placement", () => {
    for (const v of VECTORS.placement) {
      const placed = placeEntry(v.path, v.entry ?? "h", INDEX);
      expect({ path: v.path, package: placed ?? null }).toEqual({ path: v.path, package: v.package });
    }
  });

  test("a legacy manifest splits into the package files, byte for byte, and is removed", () => {
    const { legacy, files: expected, goldenFile, goldenText, gitignoreBefore, gitignoreAfter } = VECTORS.legacySplit;
    writeFileSync(join(state, ".hashes.json"), JSON.stringify(legacy, null, 2) + "\n");
    writeFileSync(join(tmp, ".metaobjects", ".gitignore"), gitignoreBefore);
    withManifestBatch(state, () => {}, VECTORS.objects);
    expect(existsSync(join(state, ".hashes.json"))).toBe(false);
    expect(files()).toEqual(Object.keys(expected).sort());
    for (const [name, entries] of Object.entries(expected)) expect(read(name)).toEqual(entries);
    expect(readFileSync(join(dirOf(), goldenFile), "utf-8")).toBe(goldenText);
    expect(readFileSync(join(tmp, ".metaobjects", ".gitignore"), "utf-8")).toBe(gitignoreAfter);

    // A second identical run changes no file.
    const before = files().map((f) => statSync(join(dirOf(), f)).mtimeMs);
    withManifestBatch(state, () => {}, VECTORS.objects);
    expect(files().map((f) => statSync(join(dirOf(), f)).mtimeMs)).toEqual(before);
  });

  test("the gitignore rewrite replaces the legacy negation, or adds one after .gen-state/*", () => {
    const ignore = join(tmp, ".metaobjects", ".gitignore");
    const cases: [string, string][] = [
      [".gen-state/*\n!.gen-state/.hashes.json\n", ".gen-state/*\n!.gen-state/.hashes/\n"],
      ["a/\n.gen-state/*\n", "a/\n.gen-state/*\n!.gen-state/.hashes/\n"],
      [".gen-state/*\n!.gen-state/.hashes/\n!.gen-state/.hashes.json\n", ".gen-state/*\n!.gen-state/.hashes/\n"],
      [".gen-state/*\n!.gen-state/.hashes/\n", ".gen-state/*\n!.gen-state/.hashes/\n"],
      ["node_modules/\n!.gen-state/.hashes.json\n", "node_modules/\n!.gen-state/.hashes.json\n"],
    ];
    for (const [before, after] of cases) {
      writeFileSync(ignore, before);
      writeFileSync(join(state, ".hashes.json"), JSON.stringify({ "a.ts": "h" }));
      withManifestBatch(state, () => {});
      expect(readFileSync(ignore, "utf-8")).toBe(after);
    }
  });

  test("a save that does not migrate leaves .gitignore alone", () => {
    const ignore = join(tmp, ".metaobjects", ".gitignore");
    writeFileSync(ignore, ".gen-state/*\n!.gen-state/.hashes.json\n");
    save({ "gen/Order.ts": "o1" });
    expect(readFileSync(ignore, "utf-8")).toBe(".gen-state/*\n!.gen-state/.hashes.json\n");
  });
});

describe("different packages, different files", () => {
  const entries = (): Record<string, unknown> => ({
    "gen/Order.ts": "o1",
    "gen/Customer.ts": "c1",
    "gen/index.ts": "i1",
  });

  test("a change in one package rewrites that package's file and no other", async () => {
    save(entries());
    expect(files()).toEqual([".root.json", "acme.crm.json", "acme.shop.json"]);
    const mtime = (f: string): number => statSync(join(dirOf(), f)).mtimeMs;
    const before = Object.fromEntries(files().map((f) => [f, mtime(f)]));
    await new Promise((r) => setTimeout(r, 20));
    save({ ...entries(), "gen/Order.ts": "o2" });
    expect(mtime("acme.crm.json")).toBe(before["acme.crm.json"]!);
    expect(mtime(".root.json")).toBe(before[".root.json"]!);
    expect(mtime("acme.shop.json")).toBeGreaterThan(before["acme.shop.json"]!);
    expect(read("acme.shop.json")).toEqual({ "gen/Order.ts": "o2" });
  });

  test("a save that changes nothing writes nothing", async () => {
    save(entries());
    const before = files().map((f) => statSync(join(dirOf(), f)).mtimeMs);
    await new Promise((r) => setTimeout(r, 20));
    save(entries());
    expect(files().map((f) => statSync(join(dirOf(), f)).mtimeMs)).toEqual(before);
  });

  test("a package that loses its last entry loses its file", () => {
    save(entries());
    const { "gen/Customer.ts": _gone, ...rest } = entries();
    save(rest);
    expect(files()).toEqual([".root.json", "acme.shop.json"]);
  });

  test("an empty manifest keeps .root.json as {} so it is not mistaken for no manifest", () => {
    save({});
    expect(files()).toEqual([".root.json"]);
    expect(readFileSync(join(dirOf(), ".root.json"), "utf-8")).toBe("{}\n");
  });

  test("an entry with no opinion stays in the file it was read from", () => {
    save(entries());
    // No model: `Order.ts` has no sourceNode, so the stem rule cannot run and it must stay.
    writeManifestFiles(state, { ...entries(), "gen/Order.ts": "o3" }, readManifestState(state), undefined);
    expect(read("acme.shop.json")).toEqual({ "gen/Order.ts": "o3" });
    expect(read(".root.json")).toEqual({ "gen/index.ts": "i1" });
  });

  test("readers see the union, and forgetting a path removes it from its own file", () => {
    save(entries());
    expect(listGeneratedPaths(state).sort()).toEqual(["gen/Customer.ts", "gen/Order.ts", "gen/index.ts"]);
    forgetGeneratedPaths(state, ["gen/Customer.ts"]);
    expect(listGeneratedPaths(state).sort()).toEqual(["gen/Order.ts", "gen/index.ts"]);
    expect(files()).toEqual([".root.json", "acme.shop.json"]);
  });
});

describe("a read does not migrate", () => {
  test("reading a legacy manifest leaves the legacy file and creates no package file", () => {
    writeFileSync(join(state, ".hashes.json"), JSON.stringify({ "a.ts": "h" }));
    expect(listGeneratedPaths(state)).toEqual(["a.ts"]);
    expect(existsSync(join(state, ".hashes.json"))).toBe(true);
    expect(existsSync(dirOf())).toBe(false);
  });
});
