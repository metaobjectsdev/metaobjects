#!/usr/bin/env node
// Tests for scripts/publish-set.mjs — the derivation both publish paths read.
//
// Two halves. The synthetic cases drive each invariant against a throwaway
// workspace on disk (the real tree is, by design, always valid — so it can only
// ever prove the happy path). The regression case then pins the actual defect
// against the real tree: @metaobjectsdev/docs-site is a runtime dependency of
// @metaobjectsdev/cli, so it must be in the set and must publish BEFORE it.
//
//   node scripts/test-publish-set.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishSet, TIER_ORDER } from "./publish-set.mjs";

let fails = 0;
const ok = (m) => console.log(`ok:   ${m}`);
const bad = (m) => { console.error(`FAIL: ${m}`); fails++; };

/** Build a throwaway workspace from `{ short: {private?, version?, deps?} }`. */
function fixture(specs) {
  const root = mkdtempSync(join(tmpdir(), "publish-set-"));
  mkdirSync(join(root, "server/typescript/packages"), { recursive: true });
  mkdirSync(join(root, "client/web/packages"), { recursive: true });
  for (const [short, s] of Object.entries(specs)) {
    const dir = join(root, s.client ? "client/web/packages" : "server/typescript/packages", short);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: `@metaobjectsdev/${short}`,
      version: s.version ?? "1.0.0",
      ...(s.private ? { private: true } : {}),
      dependencies: Object.fromEntries((s.deps ?? []).map((d) => [`@metaobjectsdev/${d}`, "workspace:*"])),
    }));
  }
  return root;
}

function expectThrow(name, fn, needle) {
  let root;
  try {
    root = fn();
    bad(`${name}: expected a throw, got none`);
  } catch (e) {
    if (String(e.message).includes(needle)) ok(`${name}: threw on "${needle}"`);
    else bad(`${name}: threw the wrong error: ${e.message}`);
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

function withFixture(specs, fn) {
  const root = fixture(specs);
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 1. happy path: non-private + at the CLI's version, ordered by tier ────────
withFixture(
  { metadata: {}, render: {}, "docs-site": { deps: ["metadata", "render"] },
    cli: { deps: ["docs-site", "metadata"] },
    conformance: { private: true, version: "0.1.0" },   // private → excluded
    angular: { version: "0.6.0", client: true } },      // off-lockstep → excluded
  (root) => {
    const { lockstep, set } = publishSet({ root });
    const names = set.map((p) => p.short);
    if (lockstep !== "1.0.0") bad(`happy path: lockstep ${lockstep}, expected 1.0.0`);
    else if (names.join(",") !== "metadata,render,docs-site,cli")
      bad(`happy path: order was [${names.join(", ")}]`);
    else ok(`happy path: private + off-lockstep excluded, order [${names.join(", ")}]`);
  },
);

// ── 2. a set member with no declared tier ────────────────────────────────────
// The bug's mechanism: TIER_ORDER.indexOf() === -1 does not sort last, it sorts
// FIRST — ahead of the package's own dependencies.
expectThrow("untiered member", () => {
  const root = fixture({ metadata: {}, cli: { deps: ["metadata"] }, "brand-new": { deps: ["metadata"] } });
  publishSet({ root });
  return root;
}, "publish order undeclared");

// ── 3. the defect itself: the set is not closed over its runtime deps ────────
// cli pins a sibling nobody publishes → an uninstallable tarball.
expectThrow("unclosed set", () => {
  const root = fixture({
    metadata: {},
    "docs-site": { version: "0.0.1", deps: ["metadata"] },   // off-lockstep ⇒ not published
    cli: { deps: ["metadata", "docs-site"] },
  });
  publishSet({ root });
  return root;
}, "not closed over its own runtime dependencies");

// ── 4. a tier order that publishes a dependency after its dependent ──────────
expectThrow("inverted tier order", () => {
  const root = fixture({ metadata: {}, cli: { deps: ["metadata"] } });
  publishSet({ root, tierOrder: ["cli", "metadata"] });
  return root;
}, "publishes a dependency AFTER its dependent");

// ── 5. regression, against the REAL tree ─────────────────────────────────────
// @metaobjectsdev/docs-site was absent from publish-npm.yml's hardcoded list and
// from release.mjs's TIER_ORDER, while @metaobjectsdev/cli depends on it.
{
  const { set } = publishSet();
  const names = set.map((p) => p.pkg.name);
  const iDocs = names.indexOf("@metaobjectsdev/docs-site");
  const iCli = names.indexOf("@metaobjectsdev/cli");
  if (iDocs === -1) bad("regression: @metaobjectsdev/docs-site is not in the publish set");
  else if (iCli === -1) bad("regression: @metaobjectsdev/cli is not in the publish set");
  else if (iDocs > iCli) bad(`regression: docs-site (#${iDocs}) publishes after cli (#${iCli})`);
  else ok(`regression: docs-site (#${iDocs}) publishes before cli (#${iCli}) in the real tree`);

  // and it is a declared tier, not an accident of indexOf() === -1
  if (!TIER_ORDER.includes("docs-site")) bad("regression: docs-site is not in TIER_ORDER");
  else ok("regression: docs-site has a declared tier");
}

console.log(fails ? `\n${fails} test(s) FAILED` : "\npublish-set tests: all passed");
process.exit(fails ? 1 : 0);
