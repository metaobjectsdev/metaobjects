/**
 * The injector — the one place that turns a payload into pages.
 *
 * Used by BOTH the deploy workflow and the local preview, so it is a shared module.
 * Two copies would drift, and a preview that renders differently from the deploy is
 * worse than no preview: it makes the wrong thing look verified.
 *
 * **This file is plain ESM (.mjs), deliberately.** The site's Pages workflow runs it
 * directly — its only toolchain step is `actions/setup-node@v4`, so there is no `bun`
 * and no build step on that runner. Making the `.mjs` the SOLE implementation, rather
 * than porting a second copy for CI, is what keeps the deploy and the local preview
 * from rendering differently: a preview that disagrees with the deploy is worse than
 * no preview, because it makes the wrong thing look verified. It is typechecked —
 * `tsconfig.scripts.json` includes `scripts/site/*.mjs` under `checkJs`, so moving it
 * out of `.ts` did not move it out of the gate.
 *
 * A placeholder is a `<pre>` carrying `data-snippet="<id>"`. The injector replaces its
 * contents and, for a snippet that ships its whole file, appends a `<details>` after it.
 * Everything emitted is plain HTML — the site has zero `<script>` tags and keeps it that
 * way, so expand-to-view is a `<details>`, not a click handler.
 */
/**
 * @typedef {import("./payload.js").SitePayload} SitePayload
 */

/**
 * Ids come out of the page's own HTML, so they are UNTRUSTED regex input. An unescaped
 * `.` over-matches an id differing only there, and a `(` or `[` throws SyntaxError — at
 * deploy time, which is the run nobody is watching.
 */
/** @type {(s: string) => string} */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A placeholder plus anything the last run appended to it.
 *
 * The trailing `<details>` group is what makes injection IDEMPOTENT: it sits outside the
 * `<pre>`, so without matching it here a second run would append a second copy, and the
 * deploy runs on every push.
 */
/** @type {(id: string) => RegExp} */
const BLOCK = (id) => new RegExp(
  `(<pre[^>]*data-snippet="${escapeRe(id)}"[^>]*>)[\\s\\S]*?(</pre>)` +
  `(\\s*<details[^>]*>[\\s\\S]*?</details>)?`, "g");

const PLACEHOLDER = /<pre[^>]*data-snippet="([^"]+)"/g;

/** Every id the page references, in document order, repeats included. */
/**
 * @param {string} html
 * @returns {string[]}
 */
export function collectPlaceholderIds(html) {
  return [...html.matchAll(PLACEHOLDER)]
    .map((m) => m[1])
    .filter((id) => id !== undefined);
}

/**
 * @param {string} html
 * @param {SitePayload} payload
 * @returns {string}
 */
export function injectSnippets(html, payload) {
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
    out = out.replace(BLOCK(id), (/** @type {string} */ _m, /** @type {string} */ open, /** @type {string} */ close) =>
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
/**
 * @param {Record<string, string>} htmlById
 * @param {SitePayload} payload
 * @returns {void}
 */
export function assertBijection(htmlById, payload) {
  /** @type {Map<string, string[]>} */
  const seen = new Map();                            // id -> files naming it
  /** @type {string[]} */
  const duplicates = [];                             // "id (file)"
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
