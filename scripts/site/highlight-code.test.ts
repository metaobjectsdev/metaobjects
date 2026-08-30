import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { highlightCode, PALETTE } from "./highlight-code.js";

const REPO = resolve(import.meta.dirname, "../..");
const real = (p: string) => readFileSync(resolve(REPO, p), "utf8");

const classesIn = (html: string): string[] =>
  [...html.matchAll(/class="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((c): c is string => c !== undefined);

/** Strip spans and reverse every entity the highlighters emit. &amp; must be LAST. */
const unhighlight = (html: string) =>
  html.replace(/<\/?span[^>]*>/g, "")
      .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");

describe("highlightCode", () => {
  // Over REAL generated output, not a one-liner. A one-liner contains no function
  // or class title, so it cannot see the multi-class sub-scope spans that leak.
  test("emits ONLY the site's palette classes, over real generated output", () => {
    const html = highlightCode(real("examples/showcase/generated/ts/Subscriber.ts"), "ts");
    const classes = classesIn(html);
    expect(classes.length).toBeGreaterThan(10);
    // Widened, not asserted: `PALETTE` is a const tuple, so `toContain` narrows its
    // argument to the six literals — which makes the one thing this test exists to
    // ask ("is this class the site emitted one of them?") unaskable.
    const palette: readonly string[] = PALETTE;
    for (const c of classes) expect(palette).toContain(c);
  });

  test("leaks no raw hljs- class, which the site's CSS does not define", () => {
    for (const [file, lang] of [
      ["examples/showcase/generated/ts/Subscriber.ts", "ts"],
      ["examples/showcase/generated/ts/Subscriber.queries.ts", "ts"],
    ] as const) {
      expect(highlightCode(real(file), lang)).not.toContain("hljs-");
    }
  });

  test("maps a string token to the string class", () => {
    expect(highlightCode(`const a = "x";`, "ts")).toContain('<span class="string">');
  });

  test("a console block marks the prompt ok and the error err", () => {
    const html = highlightCode(
      "$ meta verify\nERR_VAR_NOT_ON_PAYLOAD: displayName", "console");
    expect(html).toContain('<span class="ok">$</span>');
    expect(html).toContain('<span class="err">');
  });

  test("a full-line shell comment IS a comment", () => {
    expect(highlightCode("# scaffold the project", "console"))
      .toBe('<span class="comment"># scaffold the project</span>');
  });

  test("escapes HTML in every language", () => {
    expect(highlightCode("List<String> a;", "java")).toContain("&lt;String&gt;");
  });

  // The guarantee that highlighting never ALTERS content. If this fails, a span
  // mapping is eating or emitting characters.
  //
  // highlight.js escapes `"` to &quot; as well as the &<> that esc() covers, so the
  // reverse must undo all four — and &amp; LAST, or `&amp;lt;` unescapes twice.
  test("round-trips: stripping the spans returns the original source", () => {
    for (const [file, lang] of [
      ["examples/showcase/generated/ts/Subscriber.ts", "ts"],
      ["examples/showcase/generated/ts/prompts.ts", "ts"],
    ] as const) {
      const src = real(file);
      expect(unhighlight(highlightCode(src, lang))).toBe(src);
    }
  });

  test("round-trips a console transcript too", () => {
    const src = "$ meta verify\nERR_X: a<b\n# note";
    expect(unhighlight(highlightCode(src, "console"))).toBe(src);
  });
});
