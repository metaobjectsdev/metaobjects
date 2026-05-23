import { describe, test, expect } from "bun:test";
import { render, InMemoryProvider } from "../src/index.js";

const P = (m: Record<string, string>) => new InMemoryProvider(m);

describe("render engine", () => {
  test("renders a variable (text, raw)", () => {
    expect(render({ template: "Hi {{name}}.", payload: { name: "Ada" }, provider: P({}), format: "text" })).toBe("Hi Ada.");
  });

  test("resolves a template by 2-layer ref", () => {
    expect(render({ ref: "g/main", payload: { name: "Ada" }, provider: P({ "g/main": "Hi {{name}}." }) })).toBe("Hi Ada.");
  });

  test("iterates arrays in order", () => {
    expect(render({ template: "{{#xs}}{{.}},{{/xs}}", payload: { xs: ["a", "b", "c"] }, provider: P({}) })).toBe("a,b,c,");
  });

  test("inverted section when empty", () => {
    expect(render({ template: "{{^xs}}none{{/xs}}", payload: { xs: [] }, provider: P({}) })).toBe("none");
  });

  test("resolves partials through the provider", () => {
    const p = P({ "g/main": "A {{> g/frag }} B", "g/frag": "[{{x}}]" });
    expect(render({ ref: "g/main", payload: { x: "z" }, provider: p })).toBe("A [z] B");
  });

  test("renders a partial once per loop iteration in the item context", () => {
    const p = P({ "g/main": "{{#items}}{{> g/row }}{{/items}}", "g/row": "<{{n}}>" });
    expect(render({ ref: "g/main", payload: { items: [{ n: 1 }, { n: 2 }] }, provider: p, format: "text" })).toBe("<1><2>");
  });

  test("detects partial cycles", () => {
    const p = P({ "g/a": "{{> g/b }}", "g/b": "{{> g/a }}" });
    expect(() => render({ ref: "g/a", payload: {}, provider: p })).toThrow(/cycle/i);
  });

  test("html format escapes markup", () => {
    expect(render({ template: "{{x}}", payload: { x: "<b>&" }, provider: P({}), format: "html" })).toBe("&lt;b&gt;&amp;");
  });

  test("text format does not escape", () => {
    expect(render({ template: "{{x}}", payload: { x: "<b>&" }, provider: P({}), format: "text" })).toBe("<b>&");
  });

  test("triple-mustache bypasses escaping", () => {
    expect(render({ template: "{{{x}}}", payload: { x: "<b>" }, provider: P({}), format: "html" })).toBe("<b>");
  });

  test("csv format neutralizes formula injection", () => {
    expect(render({ template: "{{x}}", payload: { x: "=cmd()" }, provider: P({}), format: "csv" })).toBe("'=cmd()");
  });

  test("csv format quotes values with commas", () => {
    expect(render({ template: "{{x}}", payload: { x: "a,b" }, provider: P({}), format: "csv" })).toBe('"a,b"');
  });

  test("spreadsheet format xml-escapes and guards injection", () => {
    expect(render({ template: "{{x}}", payload: { x: "=1<2" }, provider: P({}), format: "spreadsheet" })).toBe("'=1&lt;2");
  });

  test("throws on unresolved ref", () => {
    expect(() => render({ ref: "g/missing", payload: {}, provider: P({}) })).toThrow(/unresolved/i);
  });

  test("deterministic: same inputs → identical output across runs", () => {
    const opts = { template: "{{#xs}}{{.}}|{{/xs}}", payload: { xs: [1, 2, 3] }, provider: P({}), format: "text" as const };
    expect(render(opts)).toBe(render(opts));
    expect(render(opts)).toBe("1|2|3|");
  });
});

// The fail-closed guard for dynamic/generated text (FR-004 Plan #3, T6): given a
// payload field tree via `verify`, render() checks the RESOLVED text before
// emitting and rejects a drifted variant, instead of silently rendering nothing.
describe("render — verify-on-resolve guard", () => {
  const author = [{ name: "displayName" }, { name: "postCount" }];

  test("a clean template renders normally with the guard on", () => {
    expect(
      render({ template: "Hi {{displayName}}.", payload: { displayName: "Ada" }, provider: P({}), verify: author }),
    ).toBe("Hi Ada.");
  });

  test("a drifted variable throws before rendering", () => {
    expect(() =>
      render({ template: "Hi {{notARealField}}.", payload: {}, provider: P({}), verify: author }),
    ).toThrow(/ERR_VAR_NOT_ON_PAYLOAD/);
  });

  test("the guard checks the provider-resolved text (dynamic provider)", () => {
    const p = P({ "g/dynamic": "{{ghostField}}" });
    expect(() => render({ ref: "g/dynamic", payload: {}, provider: p, verify: author })).toThrow(
      /ERR_VAR_NOT_ON_PAYLOAD/,
    );
  });
});
