#!/usr/bin/env bun
/**
 * Local preview — render the site as the deploy would, without touching the site repo.
 *
 *   bun run site:preview --site <path-to-site-checkout> [--strict]
 *
 * It copies the checkout to a scratch directory and injects there. The site repo is
 * NEVER written to: a preview that mutates the thing it previews turns "let me look"
 * into an accidental commit, and the injected HTML is build output that must not be
 * committed to a repo whose pages are the source.
 *
 * The injector is imported, not reimplemented — the deploy and the preview must agree,
 * and a preview that renders differently from the deploy is worse than none, because it
 * makes the wrong thing look verified.
 *
 * `--strict` makes a payload/page mismatch fatal. It is OFF by default on purpose: while
 * the pages are being given placeholders, most payload entries are legitimately not on a
 * page yet, and a preview that refuses to run until the last one lands is a preview
 * nobody can use during the work it exists to support. The DEPLOY is where the bijection
 * is enforced.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { injectSnippets, injectRegistries, collectPlaceholderIds, collectRegistryKeys, assertBijection } from "./site/inject.mjs";
import type { SitePayload } from "./site/payload.js";

const REPO = resolve(import.meta.dirname, "..");
const PAYLOAD = resolve(REPO, "examples/showcase/site-payload.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const site = arg("site");
const STRICT = process.argv.includes("--strict");
if (!site) {
  console.error(
    "usage: bun run site:preview --site <path-to-site-checkout> [--strict]\n" +
    "  Copies the checkout to a scratch dir and injects the committed payload there.\n" +
    "  The site checkout is never modified.");
  process.exit(2);
}
const SITE = resolve(site);
if (!statSync(SITE, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`✗ not a directory: ${SITE}`);
  process.exit(2);
}

function htmlFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...htmlFiles(full, base));
    else if (entry.endsWith(".html")) out.push(relative(base, full));
  }
  return out.sort();
}

const payload = JSON.parse(readFileSync(PAYLOAD, "utf8")) as SitePayload;
const dest = mkdtempSync(join(tmpdir(), "site-preview-"));
cpSync(SITE, dest, { recursive: true, filter: (src) => !src.includes(`${"/"}.git${"/"}`) });

const pages = htmlFiles(dest, dest);
const htmlById: Record<string, string> = {};
let filled = 0;
let coordsFilled = 0;

for (const rel of pages) {
  const full = join(dest, rel);
  const src = readFileSync(full, "utf8");
  htmlById[rel] = src;
  const ids = collectPlaceholderIds(src);
  const coords = collectRegistryKeys(src);
  // Both, not just ids: a page carrying only version coordinates has no snippet
  // placeholder, and skipping on `ids.length === 0` alone would silently leave its
  // versions stale while reporting a clean preview.
  if (ids.length === 0 && coords.length === 0) continue;
  writeFileSync(full, injectRegistries(injectSnippets(src, payload), payload));
  filled += ids.length;
  coordsFilled += coords.length;
}

const referenced = new Set(Object.values(htmlById).flatMap(collectPlaceholderIds));
const unreferenced = Object.keys(payload.snippets).filter((id) => !referenced.has(id));

console.log(
  `✓ previewed ${pages.length} page(s), filled ${filled} placeholder(s) ` +
  `and ${coordsFilled} version coordinate(s)`);
console.log(`  ${dest}`);
if (unreferenced.length > 0) {
  console.log(
    `\n  ${unreferenced.length} payload entr(ies) are on no page yet:\n` +
    `    ${unreferenced.join(", ")}\n` +
    `  Expected while the pages are still being given placeholders. ` +
    `${STRICT ? "" : "Re-run with --strict to make this fatal."}`);
}
if (STRICT) assertBijection(htmlById, payload);
