// Runtime drift: a template that references a variable the payload does not declare
// (`{{nmae}}` for `name`) must RAISE at render time, never render the variable as empty.
//
// The build-time gate cannot see this case: the helper is generated against a clean template,
// and the template text is then edited (or served by a different provider) afterwards. The
// shared corpus is fixtures/template-output-render-conformance/runtime-drift/ — its `templates/`
// holds the drifted text; the clean text the helpers are generated from is the parent corpus's
// `templates/`.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { FileSystemProvider } from "../src/render-engine/framework-provider.js";
import { renderRenderHelper } from "../src/templates/render-helper.js";
import { promptRender } from "../src/generators/prompt-render-file.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/template-output-render-conformance");
const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

async function load() {
  const json = readFileSync(join(CORPUS, "runtime-drift", "meta.json"), "utf-8");
  const res = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(res.errors).toEqual([]);
  return res.root;
}

const clean = () => new FileSystemProvider(join(CORPUS, "templates"));
const drifted = () => new FileSystemProvider(join(CORPUS, "runtime-drift", "templates"));
const PAYLOADS = "export interface Welcome { name: string; }\n";

describe("runtime drift — a variable not on the payload raises at render time", () => {
  test("render-helper (template.output)", async () => {
    const root = await load();
    const src = renderRenderHelper(root, "WelcomePage", clean());
    const dir = mkdtempSync(join(import.meta.dir, "rd-helper-"));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, "payloads.ts"), PAYLOADS);
    writeFileSync(join(dir, "WelcomePage.render.ts"), src);
    const mod = await import(join(dir, "WelcomePage.render.ts"));
    expect(mod.renderWelcomePage({ name: "Ada" }, clean())).toBe("Hello Ada");
    expect(() => mod.renderWelcomePage({ name: "Ada" }, drifted())).toThrow(/ERR_VAR_NOT_ON_PAYLOAD \(nmae\)/);
  });

  test("promptRender() handle (template.prompt)", async () => {
    const root = await load();
    const gen = promptRender();
    const out = await gen.generate({
      entities: root.objects(),
      loadedRoot: root,
      matches: () => true,
      projectRoot: "/tmp",
      config: { outDir: "/tmp", extStyle: "js", dbImport: "~/db", dialect: "sqlite" } as never,
      renderContext: undefined as never,
      warn: () => {},
    } as never);
    expect(out).toHaveLength(1);
    const dir = mkdtempSync(join(import.meta.dir, "rd-prompt-"));
    TEMP_DIRS.push(dir);
    // The handle imports the payload from the value object's own module.
    const imp = /from "(\.[^"]+)"/.exec(out[0]!.content)?.[1] ?? "./Welcome.js";
    writeFileSync(join(dir, imp.replace(/\.js$/, "") + ".ts"), PAYLOADS);
    writeFileSync(join(dir, "prompts.ts"), out[0]!.content);
    const mod = await import(join(dir, "prompts.ts"));
    expect(mod.renderWelcomePrompt({ name: "Ada" }, clean())).toBe("Hello Ada");
    expect(() => mod.renderWelcomePrompt({ name: "Ada" }, drifted())).toThrow(/ERR_VAR_NOT_ON_PAYLOAD \(nmae\)/);
  });
});
