#!/usr/bin/env bun
/**
 * Build (or check) the site payload — the single artifact metaobjects.dev renders.
 *
 *   bun run site:payload            # write examples/showcase/site-payload.json
 *   bun scripts/build-site-payload.ts --check   # fail if the committed file is stale
 *
 * The payload is COMMITTED so the site's deploy has no build step of its own and the
 * diff of what the site will publish is reviewable in a pull request. That only means
 * something while the committed file matches what a fresh build produces, which is what
 * `--check` enforces in the gates lane.
 *
 * Every gate lives in buildPayload, not here — this file only decides whether to write
 * the result or compare it.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { buildPayload } from "./site/payload.js";

const REPO = resolve(import.meta.dirname, "..");
const OUT = resolve(REPO, "examples/showcase/site-payload.json");
const CHECK = process.argv.includes("--check");

const json = `${JSON.stringify(buildPayload(REPO), null, 2)}\n`;

if (CHECK) {
  if (!existsSync(OUT)) {
    console.error(`✗ ${relative(REPO, OUT)} does not exist — run \`bun run site:payload\` and commit it`);
    process.exit(1);
  }
  if (readFileSync(OUT, "utf8") !== json) {
    console.error(
      `✗ ${relative(REPO, OUT)} is stale — the site would publish something other than\n` +
      `  what this repository currently generates.\n` +
      `  Run \`bun run site:payload\`, review the diff, and commit.`);
    process.exit(1);
  }
  console.log(`✓ ${relative(REPO, OUT)} is fresh`);
} else {
  writeFileSync(OUT, json);
  console.log(`✓ wrote ${relative(REPO, OUT)}`);
}
