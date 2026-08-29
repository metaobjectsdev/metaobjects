import hljs from "highlight.js/lib/core";
import ts from "highlight.js/lib/languages/typescript";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import csharp from "highlight.js/lib/languages/csharp";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";

hljs.registerLanguage("ts", ts);
hljs.registerLanguage("java", java);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("python", python);
hljs.registerLanguage("sql", sql);

export type Lang = "ts" | "java" | "kotlin" | "csharp" | "python" | "sql" | "console";

/**
 * Every class the site's CSS defines. `comment`/`keyword`/`key`/`string` exist today
 * (www/styles.css); `ok`/`err` are added for terminal blocks and are terminal-only.
 * Anything outside this set ships unstyled, so nothing may emit one.
 */
export const PALETTE = ["comment", "keyword", "key", "string", "ok", "err"] as const;

/**
 * highlight.js emits many token scopes; the site has four code classes. Anything not
 * mapped renders as a bare <span>, which is correct — an unmapped scope should look
 * plain, never borrow another token's meaning.
 */
const SCOPE_TO_CLASS: Record<string, string> = {
  comment: "comment",
  keyword: "keyword", built_in: "keyword", type: "keyword", literal: "keyword",
  string: "string", number: "string", regexp: "string", subst: "string",
  attr: "key", property: "key", title: "key", variable: "key", params: "key",
  meta: "comment",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A terminal transcript: the prompt is `ok`, any ERR_-prefixed line is `err`. */
function highlightConsole(source: string): string {
  return source.split("\n").map((line) => {
    if (line.startsWith("$ ")) return `<span class="ok">$</span> ${esc(line.slice(2))}`;
    if (/\bERR_[A-Z_]+/.test(line)) return `<span class="err">${esc(line)}</span>`;
    // >= 0, not > 0: a full-line `# comment` is the common shell-transcript case,
    // and `> 0` renders exactly that one unstyled.
    const hash = line.indexOf("#");
    if (hash >= 0) {
      return `${esc(line.slice(0, hash))}<span class="comment">${esc(line.slice(hash))}</span>`;
    }
    return esc(line);
  }).join("\n");
}

export function highlightCode(source: string, lang: Lang): string {
  if (lang === "console") return highlightConsole(source);
  const html = hljs.highlight(source, { language: lang }).value;
  // highlight.js emits MULTI-class spans for sub-scopes: `hljs-title function_`,
  // `hljs-title class_`, `hljs-variable language_`, `hljs-meta keyword`. A regex
  // requiring exactly `hljs-<word>` cannot see them, so they would pass through
  // untouched onto a page whose CSS has no .hljs-* rules at all.
  return html.replace(/<span class="([^"]*)">/g, (_m, raw: string) => {
    for (const token of raw.split(/\s+/)) {
      const scope = token.replace(/^hljs-/, "").replace(/_$/, "");
      const cls = SCOPE_TO_CLASS[scope];
      if (cls) return `<span class="${cls}">`;
    }
    return "<span>";
  });
}
