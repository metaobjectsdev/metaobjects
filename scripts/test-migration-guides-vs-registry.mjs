#!/usr/bin/env node
// Tests for scripts/check-migration-guides-vs-registry.mjs.
//
// The gate itself can only ever prove the happy path against the real tree, because the real
// tree is (by design) compliant once the gate is green. These synthetic cases drive it in BOTH
// directions — including the exact row that shipped the defect this gate exists for — so a
// pattern that silently matches nothing cannot pass as a clean run.
//
//   node scripts/test-migration-guides-vs-registry.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registeredNames, scanGuides } from "./check-migration-guides-vs-registry.mjs";

let fails = 0;
const ok = (m) => console.log(`ok:   ${m}`);
const bad = (m) => {
  console.error(`FAIL: ${m}`);
  fails++;
};

const registry = {
  commonAttrs: [{ name: "deprecated" }],
  types: [
    { type: "requirement", subType: "functional", attrs: [{ name: "supersededBy" }, { name: "status" }], children: [] },
    { type: "origin", subType: "aggregate", attrs: [], children: [{ attrs: [{ name: "agg" }] }] },
  ],
};
const registered = registeredNames(registry);

// --- registeredNames reads every axis the manifest has -----------------------
for (const [name, present] of [
  ["@deprecated", true],   // commonAttrs
  ["@supersededBy", true], // a type's own attrs
  ["@agg", true],          // a child's attrs — missed by a naive top-level-only walk
  ["@verifiedBy", false],
]) {
  registered.attrs.has(name) === present
    ? ok(`registeredNames: @${name.slice(1)} ${present ? "seen" : "absent"}`)
    : bad(`registeredNames: expected ${name} present=${present}`);
}
registered.subTypes.has("origin.aggregate")
  ? ok("registeredNames: type.subType seen")
  : bad("registeredNames: origin.aggregate missing");

const scan1 = (text) => scanGuides([{ file: "g.md", text }], registered);

// --- THE defect this gate exists for -----------------------------------------
// The row exactly as `verified-by-retirement.md` shipped it, against a registry that
// (as of 0.24.2) registers the name again.
const shipped = "| `@supersededBy` | `ERR_UNKNOWN_ATTR` |";
scan1(shipped).length === 1
  ? ok("fires on the shipped @supersededBy retirement row")
  : bad("MISSED the row this gate exists for — the gate is decorative");

// --- correct rows must stay silent -------------------------------------------
const cases = [
  ["| `@verifiedBy` | `ERR_UNKNOWN_ATTR` |", 0, "an attr that really did stay retired"],
  ["| `origin.collection` (any use) | `ERR_UNKNOWN_SUBTYPE` |", 0, "an unregistered subtype"],
  ["| `origin.aggregate` | `ERR_UNKNOWN_SUBTYPE` |", 1, "a REGISTERED subtype claimed retired"],
  [
    "| `@supersededBy` | `ERR_UNKNOWN_ATTR` | **no** — re-registered in `0.24.2` |",
    0,
    "a row carrying its own correction is exempt",
  ],
  ["| `meta verify` | strict | `ERR_UNKNOWN_ATTR` — the build failed |", 0, "first cell is not a token"],
  [
    "`@status` shrinks, so `abandoned` fails (`ERR_UNKNOWN_ATTR` names `@verifiedBy`)",
    0,
    "prose is out of scope — the first draft flagged this",
  ],
  ["| `@supersededBy` | it is fine |", 0, "a row naming no load error is not a retirement claim"],
];
for (const [text, want, label] of cases) {
  const got = scan1(text).length;
  got === want ? ok(label) : bad(`${label}: expected ${want} finding(s), got ${got}`);
}

// --- the real manifest must actually contain the names the gate reasons about -
// A green gate over an empty name set would be indistinguishable from a green gate over a
// clean tree. Assert the inputs are real.
const root = new URL("..", import.meta.url).pathname;
const real = registeredNames(
  JSON.parse(readFileSync(join(root, "fixtures/registry-conformance/expected-registry.json"), "utf8")),
);
real.attrs.size > 50 && real.subTypes.size > 20
  ? ok(`real manifest parsed (${real.attrs.size} attrs, ${real.subTypes.size} subtypes)`)
  : bad(`real manifest looks empty: ${real.attrs.size} attrs, ${real.subTypes.size} subtypes`);
real.attrs.has("@supersededBy")
  ? ok("real manifest registers @supersededBy — the gate's inputs are live")
  : bad("real manifest does NOT register @supersededBy; the gate would pass vacuously");

console.log(fails === 0 ? "\nAll migration-guide gate tests passed." : `\n${fails} test(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
