#!/usr/bin/env bun
/**
 * Build the metamodel reference the website serves at /reference.
 *
 *   bun scripts/build-site-reference.ts                  # write site-reference/
 *   bun scripts/build-site-reference.ts --check          # fail if the committed output is stale
 *   bun scripts/build-site-reference.ts --out <dir> …    # render/check somewhere else
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
 *
 * `--out` redirects both modes at a different directory. It exists so the freshness gate
 * itself can be tested — a check whose only possible subject is the repository's own
 * committed output can only ever be exercised in the state it is already in, so its
 * "differs" and "orphan" branches were reachable by nothing. In write mode it is
 * deliberately guarded (see `resolveOut`): the write path begins by deleting its target.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { generateMarkdown, renderReference } from "./site/reference.js";

const REPO = resolve(import.meta.dirname, "..");
const CHECK = process.argv.includes("--check");

/**
 * Where the pages go. `site-reference/` unless `--out` says otherwise.
 *
 * The write branch below starts with `rmSync(OUT, { recursive: true })`, so a flag that
 * chooses that directory is a delete pointed at whatever the caller typed. A default-path
 * run is unguarded because that path is this script's own output; any OTHER directory has
 * to already look like a rendered reference, which a mistyped path will not.
 */
function resolveOut(): string {
  const i = process.argv.indexOf("--out");
  if (i === -1) return resolve(REPO, "site-reference");
  const given = process.argv[i + 1];
  if (given === undefined || given.startsWith("--")) {
    console.error("✗ --out needs a directory");
    process.exit(2);
  }
  const out = resolve(given);
  if (!CHECK && existsSync(out) && !existsSync(join(out, "index.html"))) {
    console.error(
      `✗ refusing to write into ${out}: it exists and holds no index.html, so it is not\n` +
      `  a rendered reference. Writing begins by deleting the target.`);
    process.exit(2);
  }
  return out;
}
const OUT = resolveOut();
/**
 * How the messages below name the target — `site-reference/` on the default path, and an
 * absolute path for anything outside the repo (a repo-relative `../../tmp/x` would be
 * true and useless).
 */
const rel = relative(REPO, OUT);
const label = rel !== "" && !rel.startsWith("..") ? `${rel}/` : OUT;

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
        `✗ ${label} is stale:\n    ${stale.join("\n    ")}\n\n` +
        `  Run \`bun scripts/build-site-reference.ts\` and commit the result.`);
      process.exit(1);
    }
    console.log(`✓ ${label} is fresh (${expected.length} page(s))`);
  } else {
    rmSync(OUT, { recursive: true, force: true });
    for (const [p, html] of Object.entries(pages)) {
      const full = join(OUT, p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, html);
    }
    console.log(`✓ wrote ${Object.keys(pages).length} page(s) → ${label}`);
  }
} finally {
  rmSync(md, { recursive: true, force: true });
}
