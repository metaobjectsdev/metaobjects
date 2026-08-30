#!/usr/bin/env node
/**
 * Deploy-time snippet injection — the entry point the site's Pages workflow runs.
 *
 *   node scripts/site-inject-ci.mjs --site <path-to-www>
 *
 * **Plain Node ESM with zero dependencies, deliberately.** The site's `deploy.yml` has
 * exactly one toolchain step, `actions/setup-node@v4`; `ubuntu-latest` carries no `bun`,
 * so a `bun` line here would be `command not found` — and, sitting before "Upload
 * artifact", it would fail the entire Pages deploy. There is no `install` step either: a
 * root `bun install` would fetch all 16 workspace packages to run a regex replace.
 *
 * The injection logic itself is NOT reimplemented here. It is imported from
 * `./site/inject.mjs`, which the local preview also imports, because two copies would
 * drift and a preview that renders differently from the deploy is worse than no
 * preview — it makes the wrong thing look verified.
 *
 * <h3>The check here is deliberately ASYMMETRIC</h3>
 *
 * - A placeholder the payload cannot fill is a **hard failure**. It would otherwise
 *   deploy a visibly empty code block, and nothing downstream of this step looks.
 * - A payload entry no page references is a **warning only**.
 *
 * Running the bidirectional check at deploy time would fail EVERY site deploy —
 * unrelated prose edits included — from the moment someone adds a placeholder until the
 * next metaobjects release. That inverts the reason the tag pin exists: to keep deploy
 * risk off release day, not to hand it to every site edit. The bidirectional half runs
 * in this repo's release preflight (`scripts/site-bijection.test.ts`), where a mismatch
 * is fixable before anything publishes.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPlaceholderIds, collectRegistryKeys, injectRegistries, injectSnippets } from "./site/inject.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAYLOAD = resolve(REPO, "examples/showcase/site-payload.json");

/** @type {(name: string) => string | undefined} */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const siteArg = arg("site");
if (!siteArg) {
  console.error("usage: node scripts/site-inject-ci.mjs --site <path-to-www>");
  process.exit(2);
}
const SITE = resolve(siteArg);
if (!statSync(SITE, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`✗ not a directory: ${SITE}`);
  process.exit(2);
}

/**
 * Every `.html` under `dir`, recursively. The site keeps articles in a subdirectory,
 * so a non-recursive walk would silently skip them — the placeholders would survive
 * into the deployed page as empty `<pre>` elements with no error anywhere.
 * @param {string} dir
 * @param {string} base
 * @returns {string[]}
 */
function htmlFiles(dir, base) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...htmlFiles(full, base));
    else if (entry.endsWith(".html")) out.push(relative(base, full));
  }
  return out.sort();
}

const payload = JSON.parse(readFileSync(PAYLOAD, "utf8"));

const pages = htmlFiles(SITE, SITE);
/** @type {Set<string>} */
const referenced = new Set();
let filled = 0;
let coordsFilled = 0;

for (const rel of pages) {
  const full = join(SITE, rel);
  const src = readFileSync(full, "utf8");
  const ids = collectPlaceholderIds(src);
  const coords = collectRegistryKeys(src);
  if (ids.length === 0 && coords.length === 0) continue;
  for (const id of ids) referenced.add(id);
  // Both injectors throw, naming the id/key and the file, when the payload cannot fill a
  // placeholder. That is the hard-failure half — let it escape.
  try {
    writeFileSync(full, injectRegistries(injectSnippets(src, payload), payload));
  } catch (err) {
    console.error(`✗ ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  filled += ids.length;
  coordsFilled += coords.length;
}

const orphans = Object.keys(payload.snippets).filter((id) => !referenced.has(id));
if (orphans.length > 0) {
  // WARN, never fail — see the asymmetry note in the header.
  console.warn(
    `warn: ${orphans.length} payload snippet(s) referenced by no page: ${orphans.join(", ")}\n` +
    `      This does not fail the deploy. The bijection is enforced in the metaobjects ` +
    `release preflight, where it can be fixed before publishing.`);
}

console.log(
  `✓ injected ${filled} placeholder(s) and ${coordsFilled} version coordinate(s) ` +
  `across ${pages.length} page(s)`);
