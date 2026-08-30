/**
 * The metamodel reference, rendered into the site's own shell.
 *
 * `meta docs --metamodel` emits markdown — sixteen pages generated from the strict
 * registry, one per type family plus an index and the provider list. That markdown is the
 * canonical form and stays so; this turns it into pages that look like the rest of
 * metaobjects.dev.
 *
 * **Rendered HERE, not at deploy.** The site's Pages workflow gets the finished HTML the
 * same way it gets the snippet payload: built in this repo, carried by the release tag,
 * copied at deploy. That keeps the metaobjects clone in the deploy dependency-free, and it
 * means the rendering is previewable and testable locally rather than only observable
 * after a publish. It is also why `meta docs --metamodel --site` refuses instead of
 * growing an HTML renderer: putting a markdown dependency into a published package for one
 * surface is the cost this avoids, and `marked` stays a repo devDependency.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { marked } from "marked";

const REPO = resolve(import.meta.dirname, "../..");

/**
 * Generate the metamodel markdown into `dir`.
 *
 * Lives HERE rather than in `build-site-reference.ts` because that file is a SCRIPT: it
 * runs its work at import time, so a test importing a helper from it would silently
 * execute the whole build — including the write to `site-reference/`. Importing a module
 * must not have side effects; a shared function belongs in a module.
 *
 * Shelled out to the CLI's real entry point rather than importing the doc renderer,
 * because `--metamodel` is the surface an adopter runs and this must break when THAT
 * breaks. `bin/meta.ts` is the executable — `src/index.ts` is a module that exits 0
 * having done nothing, which is indistinguishable from success.
 */
export function generateMarkdown(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("bun", [
    join(REPO, "server/typescript/packages/cli/bin/meta.ts"),
    "docs", "--metamodel", "--out", dir,
  ], { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`meta docs --metamodel failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
}

/**
 * The index page is `INDEX.md`, not `index.md`.
 *
 * A directory served over HTTP resolves `/reference/` to `index.html`, so the name has to
 * change on the way out. Mapped in ONE place rather than special-cased at each call site,
 * because a second copy of this rule is how `/reference/` starts 404ing while every test
 * that names the file explicitly keeps passing.
 */
const INDEX_SOURCE = "INDEX.md";
const INDEX_OUTPUT = "index.html";

/** Every `.md` under `dir`, repo-relative, deterministically ordered. */
function markdownFiles(dir: string, root: string = dir): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...markdownFiles(full, root));
    else if (name.endsWith(".md")) found.push(relative(root, full));
  }
  return found;
}

/** `INDEX.md` -> `index.html`; `types/field.md` -> `types/field.html`. */
export function outputPath(mdRelative: string): string {
  const dir = dirname(mdRelative);
  const base = mdRelative.slice(dir === "." ? 0 : dir.length + 1);
  const out = base === INDEX_SOURCE ? INDEX_OUTPUT : base.replace(/\.md$/, ".html");
  return dir === "." ? out : `${dir}/${out}`;
}

/**
 * Rewrite intra-doc links so navigation works once the pages are HTML.
 *
 * Applied to the RENDERED HTML rather than the markdown source, deliberately: a naive
 * `.md` -> `.html` pass over the source also rewrites the string inside a fenced code
 * block, and these pages document a tool whose output is markdown files. Rewriting after
 * rendering means only real `href`s are touched — code spans have already become
 * `<code>` text by then.
 */
function rewriteLinks(html: string): string {
  return html.replace(/href="([^"]+)"/g, (whole, href: string) => {
    if (/^(https?:|mailto:|#|\/)/.test(href)) return whole;      // external or absolute
    const [path, hash] = href.split("#");
    if (path === undefined || !path.endsWith(".md")) return whole;
    return `href="${outputPath(path)}${hash === undefined ? "" : `#${hash}`}"`;
  });
}

/**
 * The site's shell — the same header, nav and stylesheet every other page uses, so the
 * reference does not read as a bolted-on doc dump.
 *
 * No `<script>`, matching the rest of the site.
 *
 * Every shell link is SITE-ABSOLUTE (`/styles.css`, `/reference/`), so a page nested at
 * `types/field.html` resolves them identically to the index. A relative shell would have
 * to know its own depth, and the one page that got it wrong would look unstyled rather
 * than fail anything.
 */
function shell(title: string, body: string, isIndex: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | MetaObjects</title>
  <meta name="description" content="The MetaObjects metamodel reference — every type, subtype and attribute the loader accepts, generated from the strict registry.">
  <link rel="icon" href="/images/mo-logo-only.png" type="image/png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <style>
    /* Page-scoped — do not touch the shared landing styles. */
    .reference { max-width: 68rem; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
    .reference h1 { font-size: 2.2rem; line-height: 1.15; color: var(--primary-blue); margin: 0 0 1rem; }
    .reference h2 { font-size: 1.4rem; margin: 2.5rem 0 0.75rem; color: var(--primary-blue); }
    .reference h3 { font-size: 1.1rem; margin: 2rem 0 0.5rem; font-family: var(--font-mono); }
    .reference table { width: 100%; border-collapse: collapse; margin: 1rem 0 2rem; font-size: 0.9rem; display: block; overflow-x: auto; }
    .reference th, .reference td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--light-gray, #e5e7eb); vertical-align: top; }
    .reference th { font-weight: 600; white-space: nowrap; }
    .reference code { font-family: var(--font-mono); font-size: 0.875em; }
    .reference a { color: var(--royal-blue); }
    .reference-breadcrumb { font-family: var(--font-mono); font-size: 0.8rem; letter-spacing: 0.04em;
      text-transform: uppercase; color: var(--medium-gray); margin: 0 0 0.75rem; }
  </style>
</head>
<body>
  <header class="site-header">
    <a href="/" class="brand">
      <img src="/images/mo-logo-only.png" alt="" class="brand-mark">
      <span class="brand-name">MetaObjects</span>
    </a>
    <nav>
      <a href="/getting-started.html" class="nav-link">Get started</a>
      <a href="/story.html" class="nav-link">Story</a>
      <a href="/videos.html" class="nav-link">Videos</a>
      <a href="/reference/" class="nav-link">Reference</a>
      <a href="https://github.com/metaobjectsdev/metaobjects" class="nav-link">GitHub</a>
      <a href="https://github.com/metaobjectsdev/metaobjects/tree/main/spec" class="nav-link nav-cta">Spec</a>
    </nav>
  </header>
  <main class="reference">
    <p class="reference-breadcrumb">${isIndex
      // On the index only. `/reference/` is the METAMODEL — the vocabulary the loader
      // accepts. `/reference/example/` is a real project documented by `meta docs`, which
      // is the thing a self-referential metamodel page cannot demonstrate. Linked from
      // here because the example used to own the word "Reference" and someone following
      // an old link needs to land somewhere that explains the split.
      ? `Metamodel reference · <a href="/reference/example/">see a real project documented by <code>meta docs</code></a>`
      : `<a href="/reference/">Metamodel reference</a>`}</p>
${body}
  </main>
  <footer class="site-footer">
    <div class="site-footer-inner">
      <p>
        <strong>MetaObjects</strong> · <a href="https://github.com/metaobjectsdev/metaobjects">GitHub</a> · <a href="https://github.com/metaobjectsdev/metaobjects/blob/main/LICENSE">Apache 2.0</a> · <a href="https://github.com/metaobjectsdev/metaobjects/blob/main/spec/roadmap.md">Roadmap</a> · <a href="/llms.txt">llms.txt</a>
      </p>
      <p class="site-footer-meta">
        Generated from the strict registry by <code>meta docs --metamodel</code>. Do not edit by hand.
      </p>
    </div>
  </footer>
</body>
</html>
`;
}

/**
 * Render a directory of `meta docs --metamodel` markdown into site pages.
 *
 * @param mdDir directory holding `INDEX.md`, `providers.md` and `types/*.md`
 * @returns output-relative HTML path -> full page HTML
 */
export function renderReference(mdDir: string): Record<string, string> {
  const files = markdownFiles(mdDir);
  if (files.length === 0) {
    throw new Error(`site reference: no markdown under ${mdDir} — run \`meta docs --metamodel\` first`);
  }
  if (!files.includes(INDEX_SOURCE)) {
    throw new Error(`site reference: ${mdDir} has no ${INDEX_SOURCE}, so /reference/ would 404`);
  }

  const pages: Record<string, string> = {};
  for (const rel of files) {
    const source = readFileSync(join(mdDir, rel), "utf8");
    // The generated pages open with an HTML comment carrying the regeneration command.
    // It is useful in the markdown and noise in a browser's view-source, but it is also
    // the only in-band statement of where the page came from — so it is kept.
    const body = rewriteLinks(marked.parse(source, { async: false }));
    // The first `# ` heading is the page's own title; falling back to the path keeps a
    // heading-less page from silently becoming "undefined | MetaObjects".
    const title = /^#\s+(.+)$/m.exec(source)?.[1]?.trim() ?? rel.replace(/\.md$/, "");
    const out = outputPath(rel);
    pages[out] = shell(title, body, out === INDEX_OUTPUT);
  }
  return pages;
}
