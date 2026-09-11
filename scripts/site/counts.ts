/**
 * The counts the project states about itself — derived, never typed.
 *
 * Three numbers get quoted in prose across this repo and both web properties: how many
 * fixtures the metamodel corpus carries, how many shared corpora exist, and how many
 * base types the metamodel registers. All three drifted at once before 1.0.1 — fixtures
 * recorded as 270 / 286 / 253 against a true 313, corpora as 19 against a true 21, base
 * types as 11 and 13 against a true 14 — and `docs/CONFORMANCE.md`, the file whose own
 * header calls itself "the single place per-corpus counts are maintained", contradicted
 * ITSELF: its table said 313 while its arithmetic 200 lines below said 255.
 *
 * A number a machine can count must not live in a sentence. This module counts them
 * once; `counts.test.ts` fails the build when a typed one disagrees, and the site
 * payload carries them so the pages can stop retyping them too.
 *
 * It lives under `scripts/site/` for two reasons: it feeds the payload, and this is the
 * only directory in `scripts/` whose bun tests a CI lane actually runs
 * (`gate_site_payload` → `bun test scripts/site`). A counts test anywhere else in
 * `scripts/` would sit unrun, which is how a gate becomes decoration.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Counts {
  /** Scenario directories in the metamodel corpus — `fixtures/conformance/*`. */
  fixtures: number;
  /** Shared conformance corpora — the directories under `fixtures/`. */
  corpora: number;
  /** Distinct top-level metamodel types the registry manifest declares. */
  baseTypes: number;
}

/**
 * Directories under `fixtures/` that are NOT shared conformance corpora.
 *
 * A written reason per entry, enforced by the test, so this list can only grow by
 * decision — the same discipline as sdk's no-hardcoded-metadata-dir allowlist. Without
 * it the honest derivation ("every directory under fixtures/") would quietly become
 * "every directory someone remembered", and the count would drift the way the prose did.
 */
export const NOT_A_CORPUS: Record<string, string> = {
  "requirement-harness":
    "The requirement-test scaffold's own fixture, not a shared corpus: it exercises " +
    "requirementTests(), which is TypeScript-only, so no other port runs it and it " +
    "gates no cross-port claim.",
};

const dirsIn = (root: string, rel: string): string[] =>
  readdirSync(resolve(root, rel), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

/**
 * `fixtures` counts DIRECTORIES rather than any marker file inside them, because that is
 * exactly what the conformance runner's `discoverFixtures` counts — a fixture is a
 * scenario directory, and it throws on one with no `input/`. Counting `script.json`
 * instead would report 3.
 */
export function deriveCounts(repoRoot: string): Counts {
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(repoRoot, "fixtures/registry-conformance/expected-registry.json"), "utf8"));
  const types = (manifest as { types?: readonly { type?: unknown }[] }).types;
  if (!Array.isArray(types)) {
    throw new Error("site counts: expected-registry.json has no `types` array to count base types from.");
  }
  const baseTypes = new Set(types.map((t) => String(t.type)));

  return {
    fixtures: dirsIn(repoRoot, "fixtures/conformance").length,
    corpora: dirsIn(repoRoot, "fixtures").filter((d) => !(d in NOT_A_CORPUS)).length,
    baseTypes: baseTypes.size,
  };
}
