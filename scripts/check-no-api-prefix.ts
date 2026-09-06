/**
 * `$apiPrefix` left the generated entity descriptor in 0.25.0. Nothing SHIPPED may still
 * teach it.
 *
 * WHY THIS GATE EXISTS. `gate_doc_examples` proves shipped METADATA still loads and says
 * nothing about generated TypeScript or prose. That is the gap issue #337 records: three
 * separate times a doc or an agent-context skill taught vocabulary the loader had already
 * retired, and an adopter found it every time — never a lane. Sweeping the docs without
 * gating the sweep means the next reintroduction is silent.
 *
 * SCOPE: shipped teaching surfaces and committed generated artifacts — docs/,
 * agent-context/, examples/. Deliberately NOT client/ or server/, which legitimately
 * mention the member in order to FORBID it: the inverted tests assert
 * `not.toContain("$apiPrefix")`, and the emitters carry `@deprecated` notes explaining why
 * the parameter survives. The emitters are guarded by their own package tests, proven
 * green -> red -> green by re-introducing the prefix; this gate guards what an adopter reads.
 *
 * EXEMPTIONS, and why none is a hole:
 *   docs/superpowers/  — specs and plans are DATED RECORDS of what was decided. Rewriting
 *                        history to satisfy a gate is how a record stops being one.
 *   docs/llms/         — generated mirrors of docs/, refreshed from the source, so gating
 *                        them would report the same finding twice.
 *   docs/features/migrations/
 *                      — a migration guide's WHOLE JOB is to name what was retired and
 *                        show what replaces it. Gating it would forbid the one document
 *                        an adopter arrives at holding the old name.
 *
 * Run: bun scripts/check-no-api-prefix.ts
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOTS = ["docs", "agent-context", "examples"];
const EXEMPT = /^docs\/superpowers\/|^docs\/llms\/|^docs\/features\/migrations\//;
const NEEDLE = "$apiPrefix";

const files = execFileSync("git", ["ls-files", "-z", ...ROOTS], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f !== "" && !EXEMPT.test(f));

const hits = files.filter((f) => {
  try {
    return readFileSync(f, "utf8").includes(NEEDLE);
  } catch {
    // Unreadable or binary — not a shipped teaching surface.
    return false;
  }
});

if (hits.length > 0) {
  console.error(
    `${NEEDLE} was removed from the entity descriptor but still appears in ${hits.length} shipped file(s):`,
  );
  for (const h of hits) console.error(`  ${h}`);
  console.error(
    "\nThe client base URL is supplied at runtime: <EntityFetcherProvider fetcher={...} baseUrl=\"/api\">.\n" +
      "See docs/features/migrations/api-base-url-leaves-the-entity-descriptor.md",
  );
  process.exit(1);
}

console.log(`ok — no ${NEEDLE} in ${files.length} shipped files`);
