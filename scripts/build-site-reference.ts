#!/usr/bin/env bun
/**
 * Build the metamodel reference the website serves at /reference.
 *
 *   bun scripts/build-site-reference.ts            # write site-reference/
 *   bun scripts/build-site-reference.ts --check    # fail if the committed output is stale
 *
 * ── Why the HTML is committed ────────────────────────────────────────────────
 *
 * The site's Pages deploy clones this repo at the release tag and copies. It has
 * `actions/setup-node` and nothing else, and the metaobjects clone gets no install step —
 * that is what keeps a site deploy from depending on this workspace resolving. So the
 * rendering happens HERE, and the tag carries the finished pages, exactly as it carries
 * `examples/showcase/site-payload.json`.
 *
 * The markdown is NOT committed. It is regenerated from the registry on every run, so
 * committing it would be a second copy of a derived artifact that can go stale
 * independently — the drift this whole program exists to remove.
 *
 * `--check` is the freshness gate, and it is the reason this can be trusted: it
 * regenerates into a temp directory and byte-compares, so committed output that no longer
 * matches the registry fails the build rather than being published.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { generateMarkdown, renderReference } from "./site/reference.js";

const REPO = resolve(import.meta.dirname, "..");
const OUT = resolve(REPO, "site-reference");
const CHECK = process.argv.includes("--check");

/** Every file under `dir`, repo-relative, sorted. */
function walk(dir: string, root: string = dir): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full, root));
    else found.push(relative(root, full));
  }
  return found;
}

const md = mkdtempSync(join(tmpdir(), "mo-metamodel-md-"));
try {
  generateMarkdown(md);
  const pages = renderReference(md);

  if (CHECK) {
    const onDisk = walk(OUT);
    const expected = Object.keys(pages).sort();
    const stale: string[] = [];
    for (const p of expected) {
      const full = join(OUT, p);
      if (!existsSync(full)) { stale.push(`${p} (missing)`); continue; }
      if (readFileSync(full, "utf8") !== pages[p]) stale.push(`${p} (differs)`);
    }
    // Orphans matter as much as differences: a type family removed from the registry
    // leaves a page nobody generates any more, and it would keep being published.
    for (const p of onDisk) if (!(p in pages)) stale.push(`${p} (orphan — no longer generated)`);

    if (stale.length > 0) {
      console.error(
        `✗ site-reference/ is stale:\n    ${stale.join("\n    ")}\n\n` +
        `  Run \`bun scripts/build-site-reference.ts\` and commit the result.`);
      process.exit(1);
    }
    console.log(`✓ site-reference/ is fresh (${expected.length} page(s))`);
  } else {
    rmSync(OUT, { recursive: true, force: true });
    for (const [p, html] of Object.entries(pages)) {
      const full = join(OUT, p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, html);
    }
    console.log(`✓ wrote ${Object.keys(pages).length} page(s) → site-reference/`);
  }
} finally {
  rmSync(md, { recursive: true, force: true });
}
