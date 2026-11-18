/**
 * An application-registered naming strategy (ADR-0058 Amendment 1). `namingStrategies` in
 * metaobjects.config.ts registers a named column or table rule, and `.metaobjects/config.json`
 * selects it by name exactly as it selects a built-in. The CLI registers the project's
 * strategies before it reads `.metaobjects/config.json`, so `meta migrate` names columns
 * through it; a name no registered strategy answers is refused when the config is read.
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";
import { log } from "../src/lib/log.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme::clinic",
    children: [
      { "object.entity": { name: "Provider", children: [
        { "source.rdb": { name: "src", "@table": "providers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "npi" } },
        { "field.string": { name: "displayName" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      ] } },
    ],
  },
});

// The strategy delegates to the built-in `pascal`, looked up by name from the registry.
const TS_CONFIG = `
import { columnNamingStrategy } from "@metaobjectsdev/metadata";
const pascal = columnNamingStrategy("pascal");
const ACRONYMS = new Set(["id", "npi"]);
export default {
  generators: [],
  namingStrategies: {
    columns: { "pascal-acronyms-cli": (n: string) => (ACRONYMS.has(n) ? n.toUpperCase() : pascal(n)) },
  },
};
`;

async function project(columns: string, withTsConfig: boolean, tsConfig = TS_CONFIG): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "naming-strategies-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.clinic.json"), MODEL, "utf8");
  await mkdir(join(root, ".metaobjects", "migrations"), { recursive: true });
  await writeFile(join(root, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, naming: { columns }, migrate: { dialect: "sqlite" } }), "utf8");
  if (withTsConfig) await writeFile(join(root, "metaobjects.config.ts"), tsConfig, "utf8");
  return root;
}

let out: string[] = [];
let spies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  out = [];
  const push = (m: unknown) => { out.push(String(m)); };
  spies = [
    spyOn(log, "info").mockImplementation(push),
    spyOn(log, "error").mockImplementation(push),
    spyOn(log, "warn").mockImplementation(push),
    spyOn(console, "log").mockImplementation(push),
    spyOn(console, "error").mockImplementation(push),
  ];
});
afterEach(() => { for (const s of spies) s.mockRestore(); });

const dryRun = (root: string) =>
  run(["migrate", "--from-db", "--db", `file:${join(root, "t.db")}`, "--dialect", "sqlite", "--dry-run", "--cwd", root, "--format", "text"]);

describe("namingStrategies in metaobjects.config.ts", () => {
  test("meta migrate names columns through the registered strategy", async () => {
    const root = await project("pascal-acronyms-cli", true);
    expect(await dryRun(root)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain('"ID"');
    expect(text).toContain('"NPI"');
    expect(text).toContain('"DisplayName"');
  });

  test("a name nothing registers is refused when the config is read, naming it", async () => {
    const root = await project("pascal-acronyms-typo", true);
    expect(await dryRun(root)).not.toBe(0);
    const text = out.join("\n");
    expect(text).toContain('"naming.columns" names "pascal-acronyms-typo"');
    expect(text).toContain("TypeScript port");
  });

  // The strategy the config names lives in metaobjects.config.ts, and that file does not load. The
  // refusal that used to follow ("no strategy registered answers it") sent the reader looking for
  // a typo; the cause is the failed load, so that is what is reported.
  test("a metaobjects.config.ts that fails to load is reported, not swallowed", async () => {
    const root = await project("pascal-acronyms-broken", true, 'throw new Error("boom while loading the config");\nexport default {};\n');
    expect(await dryRun(root)).not.toBe(0);
    const text = out.join("\n");
    expect(text).toContain("metaobjects.config.ts did not load");
    expect(text).toContain("boom while loading the config");
    expect(text).toContain('so the naming strategy "pascal-acronyms-broken"');
    // Not followed by the refusal that blames the name.
    expect(text).not.toContain("Register it before .metaobjects/config.json is read");
  });

  // The config registered the strategy and THEN failed: the strategy is there, so the report is
  // the failed load alone, never "the naming strategy  that ... was not registered".
  test("a load that fails after it registered the strategy reports the load only", async () => {
    const tsConfig = `
import { registerColumnNamingStrategy } from "@metaobjectsdev/metadata";
registerColumnNamingStrategy("pascal-acronyms-late", (n: string) => n.toUpperCase());
throw new Error("boom after registering");
export default {};
`;
    const root = await project("pascal-acronyms-late", true, tsConfig);
    expect(await dryRun(root)).not.toBe(0);
    const text = out.join("\n");
    expect(text).toContain("metaobjects.config.ts did not load");
    expect(text).toContain("boom after registering");
    expect(text).not.toContain("naming strategy  that");
    expect(text).not.toContain("was not registered");
  });
});
