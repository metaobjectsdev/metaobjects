// Payload ↔ live-site bijection, checked BEFORE a release tag exists.
//
// Deliberately NOT under `scripts/site/`: `gate_site_payload` runs `bun test scripts/site`,
// which globs that directory, and this test reaches the NETWORK. The gates lane must stay
// offline-safe, so this runs from the release preflight instead — the one place a mismatch
// is still fixable before anything publishes.
//
// Why it exists at all: the deploy-time injector checks only one direction (a placeholder
// the payload cannot fill). The other direction — a payload entry no page references —
// cannot be enforced at deploy time without failing every unrelated site edit, so it is
// enforced here.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertBijection, collectPlaceholderIds, collectRegistryKeys } from "./site/inject.mjs";

const REPO = resolve(import.meta.dirname, "..");
const OWNER = "metaobjectsdev";
const SITE_REPO = "metaobjectsdev.github.io";
const TIMEOUT = 20_000;

/**
 * Every `www/**\/*.html` on the live site's default branch.
 *
 * DERIVED, never hardcoded. A hand-maintained page list is the same defect class as the
 * hand-maintained snippet ids this whole program exists to remove: the site has six pages
 * today, and the moment a placeholder lands on one that is not in the list, BOTH halves of
 * the check go wrong at once — the "payload entry on no page" half reports an orphan that
 * is not one, and the "page id with no payload entry" half misses it entirely.
 */
async function livePages(): Promise<string[]> {
  const r = await fetch(
    `https://api.github.com/repos/${OWNER}/${SITE_REPO}/git/trees/main?recursive=1`,
    { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(TIMEOUT) });
  // Fail closed. An unreachable tree must never read as "no pages, therefore no orphans".
  if (!r.ok) throw new Error(`could not list ${SITE_REPO} tree (HTTP ${r.status})`);
  const body = (await r.json()) as { truncated?: boolean; tree?: { path?: string }[] };
  if (body.truncated) throw new Error("site tree listing was truncated — cannot verify the whole site");
  const pages = (body.tree ?? [])
    .map((e) => e.path)
    .filter((p): p is string => typeof p === "string" && p.startsWith("www/") && p.endsWith(".html"));
  if (pages.length === 0) throw new Error("no www/**.html found on the live site — refusing to pass vacuously");
  return pages.sort();
}

describe("payload ↔ live site bijection", () => {
  test(
    "every payload snippet is referenced by a live page, and vice versa",
    async () => {
      const payload = JSON.parse(
        readFileSync(resolve(REPO, "examples/showcase/site-payload.json"), "utf8"));

      const pages = await livePages();
      const htmlById: Record<string, string> = {};
      for (const p of pages) {
        const r = await fetch(
          `https://raw.githubusercontent.com/${OWNER}/${SITE_REPO}/main/${p}`,
          { signal: AbortSignal.timeout(TIMEOUT) });
        // Fail closed again: a page we could not read must not read as "no placeholders".
        if (!r.ok) throw new Error(`could not read ${p} (HTTP ${r.status})`);
        htmlById[p] = await r.text();
      }

      // BOOTSTRAP, and it self-extinguishes.
      //
      // Injection is a two-repo handshake with a strict order: a release must ship the
      // injector and the payload BEFORE the site can carry placeholders, because the
      // deploy pins to the release tag and runs the injector FROM it. Until that first
      // release lands, every payload entry is legitimately on no page — and enforcing the
      // bijection here would deadlock the two repos against each other: the site cannot
      // adopt placeholders until a release ships, and the release cannot ship until the
      // site has adopted them.
      //
      // So: ZERO placeholders anywhere on the live site means "not adopted yet", which is
      // a different fact from "adopted and mismatched". It can only be true before the
      // first adopting push, and it stops being true the moment one placeholder lands —
      // at which point the full check below applies with no exception.
      const referenced = Object.values(htmlById).flatMap(collectPlaceholderIds);
      if (referenced.length === 0) {
        console.warn(
          `site-bijection: the live site references NO snippet placeholders, so injection ` +
          `has not been adopted yet.\n  This check passes only in that pre-adoption state. ` +
          `Once one placeholder is live, the full bijection is enforced.`);
        return;
      }

      expect(() => assertBijection(htmlById, payload)).not.toThrow();

      // Version coordinates, checked in the one direction that can fail.
      //
      // A `data-registry` key the payload cannot fill is a HARD failure at deploy — which
      // is the run nobody is watching, and it takes the whole Pages deploy down with it,
      // including unrelated prose edits. Catching it here means a typo on a page is a red
      // preflight before anything publishes rather than a dark site afterwards.
      //
      // Only this direction. A coordinate no page displays is not a defect: the payload
      // carries all five because they are one fact about the release, and showing four of
      // them is editorial. That is the opposite of a snippet, which is BUILT for a page.
      const known = new Set(Object.keys(payload.registries));
      const unfillable = [...new Set(Object.entries(htmlById).flatMap(([file, html]) =>
        collectRegistryKeys(html).map((k) => `${k} (${file})`)))]
        .filter((s) => !known.has(s.split(" ")[0] ?? ""));
      expect(unfillable).toEqual([]);
    },
    // Six pages plus a tree listing, over the network, from a release preflight.
    60_000,
  );
});
