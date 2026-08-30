/**
 * The injector — the one place that turns a payload into pages.
 *
 * Used by BOTH the deploy workflow and the local preview, so it is a shared module.
 * Two copies would drift, and a preview that renders differently from the deploy is
 * worse than no preview: it makes the wrong thing look verified.
 *
 * A placeholder is a `<pre>` carrying `data-snippet="<id>"`. The injector replaces its
 * contents and, for a snippet that ships its whole file, appends a `<details>` after it.
 * Everything emitted is plain HTML — the site has zero `<script>` tags and keeps it that
 * way, so expand-to-view is a `<details>`, not a click handler.
 */
import type { SitePayload } from "./payload.js";

/**
 * Ids come out of the page's own HTML, so they are UNTRUSTED regex input. An unescaped
 * `.` over-matches an id differing only there, and a `(` or `[` throws SyntaxError — at
 * deploy time, which is the run nobody is watching.
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A placeholder plus anything the last run appended to it.
 *
 * The trailing `<details>` group is what makes injection IDEMPOTENT: it sits outside the
 * `<pre>`, so without matching it here a second run would append a second copy, and the
 * deploy runs on every push.
 */
const BLOCK = (id: string) => new RegExp(
  `(<pre[^>]*data-snippet="${escapeRe(id)}"[^>]*>)[\\s\\S]*?(</pre>)` +
  `(\\s*<details[^>]*>[\\s\\S]*?</details>)?`, "g");

const PLACEHOLDER = /<pre[^>]*data-snippet="([^"]+)"/g;

/** Every id the page references, in document order, repeats included. */
export function collectPlaceholderIds(html: string): string[] {
  return [...html.matchAll(PLACEHOLDER)]
    .map((m) => m[1])
    .filter((id): id is string => id !== undefined);
}

export function injectSnippets(html: string, payload: SitePayload): string {
  let out = html;
  for (const id of new Set(collectPlaceholderIds(html))) {
    const s = payload.snippets[id];
    if (!s) {
      throw new Error(
        `site inject: no payload entry for placeholder "${id}". Either the page names an ` +
        `id the payload does not build, or the id is misspelled.`);
    }
    // `example-details` is not decoration: the site styles the expander through it, and
    // a bare <details> would ship the browser's own disclosure widget onto a page that
    // has no other one. The BLOCK regex above matches `<details[^>]*>` so this stays
    // idempotent — a class-less details left by an older deploy is still recognised.
    const details = s.full
      ? `\n<details class="example-details"><summary>Show the whole generated file (${s.lineCount} lines)</summary>\n` +
        `<pre class="example-code"><code>${s.full}</code></pre></details>`
      : "";
    // A function replacer, deliberately: the snippet is highlighted code and routinely
    // contains `$` (template literals, shell vars). A string replacement would interpret
    // `$&`/`$1` inside it and corrupt the published block.
    out = out.replace(BLOCK(id), (_m, open: string, close: string) =>
      `${open}<code>${s.inline}</code>${close}${details}`);
  }
  return out;
}

/**
 * The pages and the payload must name exactly the same ids.
 *
 * Both directions matter and they fail differently. An id in the payload that no page
 * references is dead weight the build still pays for — and, worse, the signal that a
 * page was retired without retiring its snippet. An id on a page that the payload does
 * not build cannot be filled at all, so the page would deploy with an empty block.
 *
 * DUPLICATES are reported too, and that is a hygiene rule rather than a technical
 * limit: injection handles them fine (the match is global), but two placeholders for one
 * id in a page set this small is far more likely a copy-paste than an intent. If a page
 * ever genuinely needs the same snippet twice, this is the one place to relax it.
 */
export function assertBijection(
  htmlById: Record<string, string>, payload: SitePayload,
): void {
  const seen = new Map<string, string[]>();          // id -> files naming it
  const duplicates: string[] = [];                   // "id (file)"
  for (const [file, html] of Object.entries(htmlById)) {
    const ids = collectPlaceholderIds(html);
    for (const id of new Set(ids)) {
      seen.set(id, [...(seen.get(id) ?? []), file]);
      if (ids.filter((x) => x === id).length > 1) duplicates.push(`${id} (${file})`);
    }
  }

  const orphanPayload = Object.keys(payload.snippets).filter((id) => !seen.has(id));
  const orphanPage = [...seen.keys()].filter((id) => !payload.snippets[id]);

  if (orphanPayload.length === 0 && orphanPage.length === 0 && duplicates.length === 0) return;
  throw new Error(
    `site payload and pages disagree:\n` +
    (orphanPayload.length ? `  in payload, on no page: ${orphanPayload.join(", ")}\n` : "") +
    (orphanPage.length ? `  on a page, not in payload: ${orphanPage.join(", ")}\n` : "") +
    (duplicates.length ? `  duplicate placeholder: ${duplicates.join(", ")}\n` : ""));
}
