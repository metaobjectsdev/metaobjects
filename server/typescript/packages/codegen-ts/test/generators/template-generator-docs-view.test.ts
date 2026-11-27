// The template generator over the docs view (docs/features/docs-view.md): the perNode and
// perRequirement scopes, `data: "docsView"` on perModel and perPackage, `{path}` and `root`,
// `subDir`, the asset copy and the link check. The cross-port bytes are pinned by
// fixtures/template-codegen-conformance/docs-view/; this file covers the refusals and the
// behaviour a corpus cannot show (a failed check writes nothing).

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryProvider } from "@metaobjectsdev/render";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../../src/index.js";
import { templateGenerator } from "../../src/generators/template-generator.js";
import { parseTemplateSpec } from "../../src/template-codegen/template-spec.js";
import { makeScratchDir, removeTree } from "../../src/scratch-dir.js";

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      ] } },
      { "object.value": { name: "Address", children: [{ "field.string": { name: "line1" } }] } },
      { "requirement.functional": {
        name: "Buy", "@level": 4, "@status": "live",
        "@statement": "A customer can buy.", "@counterexample": "One who cannot.",
        "@implementedBy": ["Customer"],
      } },
    ],
  },
});

async function load(): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(MODEL)]);
  expect(res.errors).toEqual([]);
  return res.root as MetaRoot;
}

const scratch: string[] = [];
afterEach(() => { for (const d of scratch.splice(0)) removeTree(d); });

async function gen(generators: ReturnType<typeof templateGenerator>[], setup?: (project: string) => void): Promise<{ out: string }> {
  const project = makeScratchDir("tmpl-view-");
  scratch.push(project);
  setup?.(project);
  const out = join(project, "out");
  await runGen({
    config: defineConfig({ outDir: out, extStyle: "none", dbImport: "~/db", dialect: "sqlite", generators }),
    metadata: await load(),
    projectRoot: project,
  });
  return { out };
}

describe("templateGenerator() over the docs view", () => {
  test("perNode renders one page per matching node at {path}, with root leading back", async () => {
    const provider = new InMemoryProvider({ node: "{{#node}}{{id}} {{type}}.{{subType}}{{/node}} root={{root}} nodes={{counts.nodes}}" });
    const { out } = await gen([templateGenerator({ name: "n", template: "node", scope: "perNode", match: "object.entity", outputPattern: "{path}", provider })]);
    expect(readFileSync(join(out, "model/acme/Customer.html"), "utf8")).toBe("acme::Customer object.entity root=../../ nodes=3");
    expect(existsSync(join(out, "model/acme/Address.html"))).toBe(false);
  });

  test("match takes a list, and * matches every node type except requirements", async () => {
    const provider = new InMemoryProvider({ node: "{{#node}}{{name}}{{/node}}" });
    const { out } = await gen([
      templateGenerator({ name: "a", template: "node", scope: "perNode", match: ["object.value", "requirement.*"], outputPattern: "a/{name}.txt", provider }),
      templateGenerator({ name: "b", template: "node", scope: "perNode", outputPattern: "b/{name}.txt", provider }),
      templateGenerator({ name: "c", template: "node", scope: "perNode", match: ["*", "requirement.functional"], outputPattern: "c/{name}.txt", provider }),
    ]);
    expect(existsSync(join(out, "a/Address.txt")) && existsSync(join(out, "a/Buy.txt"))).toBe(true);
    expect(existsSync(join(out, "a/Customer.txt"))).toBe(false);
    for (const n of ["Address", "Customer"]) expect(existsSync(join(out, `b/${n}.txt`))).toBe(true);
    expect(existsSync(join(out, "b/Buy.txt"))).toBe(false);
    for (const n of ["Address", "Buy", "Customer"]) expect(existsSync(join(out, `c/${n}.txt`))).toBe(true);
  });

  test("a full site, perNode at the default match beside perRequirement, writes each page once", async () => {
    const provider = new InMemoryProvider({
      node: "{{#node}}node {{name}}{{/node}}",
      req: "{{#requirement}}requirement {{name}}{{/requirement}}",
    });
    const { out } = await gen([
      templateGenerator({ name: "n", template: "node", scope: "perNode", subDir: "site", outputPattern: "{path}", provider }),
      templateGenerator({ name: "r", template: "req", scope: "perRequirement", subDir: "site", outputPattern: "{path}", provider }),
    ]);
    expect(readFileSync(join(out, "site/model/acme/Customer.html"), "utf8")).toBe("node Customer");
    expect(readFileSync(join(out, "site/requirements/acme/Buy.html"), "utf8")).toBe("requirement Buy");
  });

  test("perRequirement renders each requirement; perModel and perPackage read the view on request", async () => {
    const provider = new InMemoryProvider({
      req: "{{#requirement}}{{address}} {{status}}{{/requirement}}",
      all: "{{#nodes}}{{name}} {{/nodes}}",
      pkg: "{{#package}}{{name}}={{count}}{{/package}}",
    });
    const { out } = await gen([
      templateGenerator({ name: "r", template: "req", scope: "perRequirement", outputPattern: "{path}", provider }),
      templateGenerator({ name: "m", template: "all", scope: "perModel", data: "docsView", subDir: "site", outputPattern: "all.txt", provider }),
      templateGenerator({ name: "p", template: "pkg", scope: "perPackage", data: "docsView", outputPattern: "{package}.txt", provider }),
    ]);
    expect(readFileSync(join(out, "requirements/acme/Buy.html"), "utf8")).toBe("Buy live");
    expect(readFileSync(join(out, "site/all.txt"), "utf8")).toBe("Address Buy Customer ");
    expect(readFileSync(join(out, "acme.txt"), "utf8")).toBe("acme=3");
  });

  test("a link that lands on nothing fails the run and writes nothing", async () => {
    const provider = new InMemoryProvider({
      node: `{{#node}}<a href="{{root}}{{path}}#nope">x</a> <a href="{{root}}index.html">i</a>{{/node}}`,
    });
    let err: unknown;
    let project = "";
    try {
      await gen([templateGenerator({ name: "n", template: "node", scope: "perNode", match: "object.entity", outputPattern: "{path}", format: "html", linkCheck: true, provider })], (p) => { project = p; });
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain("[n] link check failed, 2 link(s) land on nothing:");
    expect(String(err)).toContain("model/acme/Customer.html -> ../../model/acme/Customer.html#nope");
    expect(String(err)).toContain("model/acme/Customer.html -> ../../index.html");
    expect(existsSync(join(project, "out"))).toBe(false);
  });

  test("a full run does not let a link land on a generated file it no longer produces", async () => {
    const project = makeScratchDir("tmpl-view-");
    scratch.push(project);
    const out = join(project, "out");
    const provider = new InMemoryProvider({ node: "{{#node}}{{name}}{{/node}}", index: `<a href="model/acme/Address.html">a</a>` });
    const run = async (match: string[], generatorNames?: string[]) => runGen({
      config: defineConfig({ outDir: out, extStyle: "none", dbImport: "~/db", dialect: "sqlite", generators: [
        templateGenerator({ name: "n", template: "node", scope: "perNode", match, outputPattern: "{path}", format: "html", provider }),
        templateGenerator({ name: "i", template: "index", scope: "perModel", data: "docsView", outputPattern: "index.html", format: "html", linkCheck: true, provider }),
      ] }),
      metadata: await load(),
      projectRoot: project,
      ...(generatorNames !== undefined && { generatorNames }),
    });
    await run(["object.*"]);
    expect(existsSync(join(out, "model/acme/Address.html"))).toBe(true);
    await expect(run(["object.entity"])).rejects.toThrow(/index\.html -> model\/acme\/Address\.html/);
    expect(existsSync(join(out, "model/acme/Address.html"))).toBe(true);
    await run(["object.entity"], ["i"]);
  });

  test("the link check sees pages a later generator renders, and the copied assets", async () => {
    const provider = new InMemoryProvider({
      node: `{{#node}}<link href="{{root}}css/a.css"><a href="{{root}}index.html#top">i</a>{{/node}}`,
      index: `<h1 id="top">x</h1>`,
    });
    const { out } = await gen([
      templateGenerator({ name: "n", template: "node", scope: "perNode", match: "object.entity", outputPattern: "{path}", format: "html", linkCheck: true, assets: { from: "static" }, provider }),
      templateGenerator({ name: "i", template: "index", scope: "perModel", data: "docsView", outputPattern: "index.html", format: "html", provider }),
    ], (project) => {
      mkdirSync(join(project, "static", "css"), { recursive: true });
      writeFileSync(join(project, "static", "css", "a.css"), "a {}\n");
    });
    expect(readFileSync(join(out, "css/a.css"), "utf8")).toBe("a {}\n");
  });

  test("an asset that is not UTF-8 text is refused, and a missing assets directory too", async () => {
    const provider = new InMemoryProvider({ m: "x" });
    const bin = (project: string) => {
      mkdirSync(join(project, "static"));
      writeFileSync(join(project, "static", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]));
    };
    await expect(gen([templateGenerator({ name: "m", template: "m", scope: "perModel", outputPattern: "m.txt", assets: { from: "static" }, provider })], bin))
      .rejects.toThrow(/logo\.png is not a UTF-8 text file/);
    await expect(gen([templateGenerator({ name: "m", template: "m", scope: "perModel", outputPattern: "m.txt", assets: { from: "missing" }, provider })]))
      .rejects.toThrow(/assets directory does not exist: missing/);
  });

  test("refuses a configuration that cannot mean anything", () => {
    const base = { name: "x", template: "t", outputPattern: "{path}" } as const;
    expect(() => templateGenerator({ ...base, scope: "perNode", data: "entities" })).toThrow(/reads the docs view/);
    expect(() => templateGenerator({ ...base, scope: "perEntity", data: "docsView" })).toThrow(/use perNode/);
    expect(() => templateGenerator({ ...base, scope: "perModel", match: "object.*" })).toThrow(/`match` applies/);
    expect(() => templateGenerator({ ...base, scope: "perNode", match: "object" })).toThrow(/`match` takes/);
    expect(() => templateGenerator({ ...base, scope: "perNode", linkCheck: true })).toThrow(/format "html"/);
  });

  test("{path} outside perNode and perRequirement is an error naming the scopes that have it", async () => {
    const provider = new InMemoryProvider({ m: "x" });
    await expect(gen([templateGenerator({ name: "m", template: "m", scope: "perModel", data: "docsView", outputPattern: "{path}", provider })]))
      .rejects.toThrow(/uses \{path\} but no page path is in scope/);
  });
});

describe("template-spec: the docs view keys", () => {
  test("parses data, match, subDir, assets and linkCheck", () => {
    const spec = parseTemplateSpec({ generators: [{
      name: "n", template: "t", scope: "perNode", outputPattern: "{path}", format: "html",
      data: "docsView", match: ["object.*"], subDir: "site", assets: { from: "a" }, linkCheck: true,
    }] });
    expect(spec.generators[0]).toEqual({
      name: "n", template: "t", scope: "perNode", outputPattern: "{path}", format: "html",
      data: "docsView", match: ["object.*"], subDir: "site", assets: { from: "a" }, linkCheck: true,
    });
  });
  test("refuses malformed values", () => {
    const at = (extra: Record<string, unknown>) => () => parseTemplateSpec({ generators: [{ name: "n", template: "t", scope: "perNode", outputPattern: "{path}", ...extra }] });
    expect(at({ data: "view" })).toThrow(/data must be one of entities \| docsView/);
    expect(at({ match: [] })).toThrow(/match must be/);
    expect(at({ assets: { to: "x" } })).toThrow(/assets must be/);
    expect(at({ assets: { from: "a", to: "b" } })).toThrow(/assets must be \{ "from": "<dir>" \}/);
    expect(at({ linkCheck: "yes" })).toThrow(/linkCheck must be a boolean/);
  });
});
