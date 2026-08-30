import { describe, test, expect } from "bun:test";
import { injectSnippets, collectPlaceholderIds, assertBijection } from "./inject.js";
import type { SitePayload } from "./payload.js";

const payload = {
  registries: { npm: "0.24.5", pypi: "0.24.5", nuget: "0.24.5", maven: "7.24.5", metamodel: "0.13" },
  snippets: {
    "ts-entity": { lang: "ts", inline: "<span>a</span>", full: "<span>a</span>\n<span>b</span>", lineCount: 2 },
    "showcase-model": { lang: "yaml", inline: "<span>m</span>", full: null, lineCount: null },
  },
} satisfies SitePayload;

describe("injectSnippets", () => {
  test("fills a placeholder with the inline snippet", () => {
    const out = injectSnippets(`<pre class="example-code" data-snippet="showcase-model"></pre>`, payload);
    expect(out).toContain("<span>m</span>");
  });

  test("appends a <details> when a full file exists — and NO script tag", () => {
    const out = injectSnippets(`<pre class="example-code" data-snippet="ts-entity"></pre>`, payload);
    expect(out).toContain("<details");
    expect(out).toContain("Show the whole generated file (2 lines)");
    expect(out).not.toContain("<script");
  });

  // The site styles the expander through `.example-details`. A bare <details> would
  // ship with the browser's own disclosure widget on a page that has no other one —
  // and nothing on the site would fail, because the site has no tests.
  test("the appended <details> carries the class the site styles", () => {
    const out = injectSnippets(`<pre class="example-code" data-snippet="ts-entity"></pre>`, payload);
    expect(out).toContain(`<details class="example-details">`);
  });

  test("appends no <details> when there is no full file", () => {
    const out = injectSnippets(`<pre class="example-code" data-snippet="showcase-model"></pre>`, payload);
    expect(out).not.toContain("<details");
  });

  test("replaces existing content, so re-injection is idempotent", () => {
    const src = `<pre class="example-code" data-snippet="showcase-model">STALE</pre>`;
    const once = injectSnippets(src, payload);
    expect(once).not.toContain("STALE");
    expect(injectSnippets(once, payload)).toBe(once);
  });

  // The <details> is appended OUTSIDE the <pre>, so a second run has to recognise and
  // replace it too. Without that it would append a second copy every deploy — and the
  // deploy is the one run nobody watches.
  test("is idempotent for a snippet that appends a <details>", () => {
    const once = injectSnippets(`<pre class="example-code" data-snippet="ts-entity"></pre>`, payload);
    const twice = injectSnippets(once, payload);
    expect(twice).toBe(once);
    expect([...twice.matchAll(/<details[^>]*>/g)]).toHaveLength(1);
  });

  test("throws on a placeholder with no payload entry", () => {
    expect(() => injectSnippets(`<pre data-snippet="ghost"></pre>`, payload))
      .toThrow(/no payload entry.*ghost/i);
  });

  // Ids come out of the page's own HTML, so they are untrusted regex input: an
  // unescaped `.` over-matches and a `(` or `[` throws SyntaxError at deploy time.
  test("an id carrying regex metacharacters is matched literally", () => {
    const p = {
      registries: payload.registries,
      snippets: { "ts.Sub(x)[1]": { lang: "ts", inline: "<span>q</span>", full: null, lineCount: null } },
    } satisfies SitePayload;
    const out = injectSnippets(`<pre data-snippet="ts.Sub(x)[1]"></pre>`, p);
    expect(out).toContain("<span>q</span>");
    // The escape is load-bearing, not decorative: an unescaped `.` would let this id
    // match a DIFFERENT placeholder that differs only in that position.
    expect(() => injectSnippets(`<pre data-snippet="tsXSub(x)[1]"></pre>`, p))
      .toThrow(/no payload entry/i);
  });

  test("leaves a <pre> carrying no data-snippet alone", () => {
    const src = `<pre class="example-code">hand written</pre>`;
    expect(injectSnippets(src, payload)).toBe(src);
  });
});

describe("collectPlaceholderIds", () => {
  test("returns every id, in document order, including repeats", () => {
    expect(collectPlaceholderIds(
      `<pre data-snippet="a"></pre><pre data-snippet="b"></pre><pre data-snippet="a"></pre>`))
      .toEqual(["a", "b", "a"]);
  });
});

describe("assertBijection", () => {
  test("throws on a payload entry no page references", () => {
    expect(() => assertBijection({ "index.html": `<pre data-snippet="ts-entity"></pre>` }, payload))
      .toThrow(/showcase-model/);
  });

  test("throws on a page placeholder with no payload entry", () => {
    const html = { "index.html":
      `<pre data-snippet="ts-entity"></pre><pre data-snippet="showcase-model"></pre>` +
      `<pre data-snippet="ghost"></pre>` };
    expect(() => assertBijection(html, payload)).toThrow(/ghost/);
  });

  test("passes when every entry is referenced by some page", () => {
    const html = { "index.html": `<pre data-snippet="ts-entity"></pre><pre data-snippet="showcase-model"></pre>` };
    expect(() => assertBijection(html, payload)).not.toThrow();
  });

  test("a DUPLICATE placeholder for one id is reported", () => {
    const html = { "index.html":
      `<pre data-snippet="ts-entity"></pre><pre data-snippet="ts-entity"></pre>` +
      `<pre data-snippet="showcase-model"></pre>` };
    expect(() => assertBijection(html, payload)).toThrow(/duplicate.*ts-entity/i);
  });

  test("names the FILE a duplicate is in, so it can be found", () => {
    const html = {
      "index.html": `<pre data-snippet="showcase-model"></pre>`,
      "deep.html": `<pre data-snippet="ts-entity"></pre><pre data-snippet="ts-entity"></pre>`,
    };
    expect(() => assertBijection(html, payload)).toThrow(/deep\.html/);
  });
});
