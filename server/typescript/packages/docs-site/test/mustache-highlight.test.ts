import { expect, test } from "bun:test";
import { highlightMustache } from "../src/mustache-highlight";

const SRC = `{{! note }}
Hello {{name}} & {{{raw}}}
{{#items}}{{label}}{{/items}}
{{> shared/footer}}`;

test("tokenizes all forms, escapes text, links resolved refs", () => {
  const r = highlightMustache(SRC, (p) => (p === "name" || p === "items" ? `#f-${p}` : undefined));
  expect(r.html).toContain(`<span class="mu-com">{{! note }}</span>`);
  expect(r.html).toContain(`&amp;`);                                        // escaped text
  expect(r.html).toContain(`<a href="#f-name" class="mu-var">{{name}}</a>`);
  expect(r.html).toContain(`<span class="mu-raw mu-unresolved">{{{raw}}}</span>`);
  expect(r.html).toContain(`id="sec-items"`);
  expect(r.html).toContain(`<span class="mu-var mu-unresolved">{{label}}</span>`);
  expect(r.html).toContain(`<span class="mu-par">{{&gt; shared/footer}}</span>`);
  expect(r.toc).toEqual([{ name: "items", anchor: "sec-items" }]);
  expect(r.refs).toContain("name");
});

test("escapes attribute-context injection attempts", () => {
  const r = highlightMustache(`{{#x" onmouseover="alert(1)}}{{/x" onmouseover="alert(1)}}`, () => undefined);
  expect(r.html).not.toContain(`onmouseover="alert`);
  expect(r.html).toContain("&quot;");
  const r2 = highlightMustache("{{unclosed", () => undefined);
  expect(r2.html).toBe("{{unclosed");
  const r3 = highlightMustache("", () => undefined);
  expect(r3.html).toBe("");
});
