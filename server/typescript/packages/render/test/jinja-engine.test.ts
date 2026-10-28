import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  render,
  verify,
  InMemoryProvider,
  templateEngineOf,
  engineForExtension,
  jinjaReferenceLine,
  ERR_VAR_NOT_ON_PAYLOAD,
} from "../src/index.js";
import { FilesystemProvider } from "../src/providers.js";

// ADR-0061: how a body's engine is chosen, and the Jinja render path's runtime behaviour.
// What a Jinja template renders to and what the check reports are pinned by the shared
// corpora (jinja-conformance.test.ts); this file covers the selection rules around them.

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mo-jinja-"));
  mkdirSync(join(root, "p"), { recursive: true });
  writeFileSync(join(root, "p", "both.mustache"), "M {{name}}");
  writeFileSync(join(root, "p", "both.jinja"), "J {{ name }}");
  writeFileSync(join(root, "p", "only.j2"), "{% for t in tags %}{{ t }}{% if not loop.last %},{% endif %}{% endfor %}");
  writeFileSync(join(root, "p", "plain.mustache"), "{{name}}");
  writeFileSync(join(root, "p", "inc.jinja"), '{% include "p/part" %}!');
  writeFileSync(join(root, "p", "part.jinja2"), "<{{ name }}>");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("engine selection", () => {
  test("an extension selects the engine; anything else is Mustache", () => {
    expect(engineForExtension(".jinja")).toBe("jinja");
    expect(engineForExtension(".J2")).toBe("jinja");
    expect(engineForExtension(".jinja2")).toBe("jinja");
    expect(engineForExtension(".mustache")).toBe("mustache");
    expect(engineForExtension(".txt")).toBe("mustache");
  });

  test("FilesystemProvider prefers Mustache, falls back to Jinja, and reports which it read", () => {
    const fs = new FilesystemProvider(root);
    expect(fs.resolve("p/both")).toBe("M {{name}}");
    expect(fs.engineOf("p/both")).toBe("mustache");
    expect(fs.engineOf("p/only")).toBe("jinja");
    expect(fs.engineOf("p/missing")).toBeUndefined();
  });

  test("an explicit extension reads that extension only", () => {
    const fs = new FilesystemProvider(root, ".jinja");
    expect(fs.resolve("p/both")).toBe("J {{ name }}");
    expect(fs.resolve("p/plain")).toBeUndefined();
  });

  test("an explicit .mustache does not fall back to a Jinja file", () => {
    const fs = new FilesystemProvider(root, ".mustache");
    expect(fs.resolve("p/only")).toBeUndefined();
    expect(fs.engineOf("p/only")).toBeUndefined();
    expect(fs.resolve("p/both")).toBe("M {{name}}");
  });

  test("an explicit engine wins over the provider; no provider knowledge means Mustache", () => {
    const fs = new FilesystemProvider(root);
    expect(templateEngineOf(fs, "p/only", "mustache")).toBe("mustache");
    expect(templateEngineOf(new InMemoryProvider({ a: "x" }), "a")).toBe("mustache");
    expect(templateEngineOf(new InMemoryProvider({ a: "x" }, { engine: "jinja" }), "a")).toBe("jinja");
  });
});

describe("render", () => {
  const fs = (): FilesystemProvider => new FilesystemProvider(root);

  test("a ref that resolves to a Jinja file renders with Jinja, includes and all", () => {
    expect(render({ ref: "p/only", payload: { tags: ["a", "b"] }, provider: fs() })).toBe("a,b");
    expect(render({ ref: "p/inc", payload: { name: "x&y" }, provider: fs(), format: "html" })).toBe("<x&amp;y>!");
  });

  test("inline template text is Mustache unless the caller names the engine", () => {
    const provider = new InMemoryProvider({});
    expect(render({ template: "{{ name }}", payload: { name: "a" }, provider })).toBe("a");
    expect(render({ template: "{{ name | upper }}", payload: { name: "a" }, provider, engine: "jinja" })).toBe("A");
  });

  test("the runtime check refuses a Jinja body that drifted from its payload", () => {
    expect(() =>
      render({ ref: "p/only", payload: { tags: [] }, provider: fs(), verify: [{ name: "labels", isArray: true }] }),
    ).toThrow(`render verify failed: ${ERR_VAR_NOT_ON_PAYLOAD} (tags)`);
    expect(render({ ref: "p/only", payload: { tags: ["a"] }, provider: fs(), verify: [{ name: "tags", isArray: true }] })).toBe("a");
  });

  test("maxChars applies to a Jinja render", () => {
    expect(() =>
      render({ template: "{{ name }}", payload: { name: "abcdef" }, provider: new InMemoryProvider({}), engine: "jinja", maxChars: 3 }),
    ).toThrow("render exceeded maxChars budget: 6 > 3");
  });

  test("a render leaves the engine's own escape function as it found it", () => {
    const provider = new InMemoryProvider({});
    render({ template: "{{ a }}", payload: { a: "<" }, provider, engine: "jinja", format: "html" });
    expect(render({ template: "{{ a }}", payload: { a: "<" }, provider, engine: "jinja", format: "text" })).toBe("<");
  });
});

describe("verify", () => {
  test("engine: jinja checks Jinja syntax; the default stays Mustache", () => {
    const fields = [{ name: "user", fields: [{ name: "name" }] }];
    expect(verify("{{ user.nope }}", fields, { engine: "jinja" })).toEqual([
      { code: ERR_VAR_NOT_ON_PAYLOAD, path: "user.nope" },
    ]);
    expect(verify("{{user.name}}", fields)).toEqual([]);
  });

  test("jinjaReferenceLine finds the line a name is first used on", () => {
    expect(jinjaReferenceLine("a\n{% if x %}\n{{ user.nope }}\n{% endif %}", "user.nope")).toBe(3);
    expect(jinjaReferenceLine("{{ a }}", "b")).toBeUndefined();
    expect(jinjaReferenceLine("{{ broken", "a")).toBeUndefined();
  });
});
