#!/usr/bin/env node
// Tests for scripts/check-metamodel-version.mjs — the classifier the metamodel-version
// gate reads.
//
// The gate itself can only ever prove the happy path against the real tree, because the
// real tree is (by design) always compliant once the gate is green. These synthetic cases
// drive EVERY classification rule in both directions, so a rule that is silently backwards
// — a `max` comparison inverted, an `allowedValues` narrowing read as a widening — shows
// up here instead of shipping as a gate that passes a breaking change.
//
//   node scripts/test-metamodel-version.mjs

import { classify, requiredBump, satisfies, parseVersion } from "./check-metamodel-version.mjs";

let fails = 0;
const ok = (m) => console.log(`ok:   ${m}`);
const bad = (m) => {
  console.error(`FAIL: ${m}`);
  fails++;
};

// ---------------------------------------------------------------------------
// Manifest builders — the smallest shape the classifier reads.
// ---------------------------------------------------------------------------

const attr = (name, over = {}) => ({
  name,
  valueType: "string",
  isArray: false,
  required: false,
  description: "d",
  ...over,
});

const child = (childType, over = {}) => ({
  childType,
  childSubType: "*",
  childName: "*",
  min: 0,
  max: null,
  ...over,
});

const type = (t, sub, over = {}) => ({
  type: t,
  subType: sub,
  description: "d",
  attrs: [],
  children: [],
  ...over,
});

const manifest = (over = {}) => ({
  metamodelVersion: "1.0",
  types: [type("field", "string")],
  commonAttrs: [],
  defaultSubTypes: { object: "entity" },
  ...over,
});

/** Assert that base→cur classifies into exactly the expected buckets. */
function check(label, base, cur, expect) {
  const got = classify(base, cur);
  for (const bucket of ["breaking", "additive", "prose"]) {
    const want = expect[bucket] ?? 0;
    if (got[bucket].length !== want) {
      bad(
        `${label}: expected ${want} ${bucket}, got ${got[bucket].length}` +
          (got[bucket].length ? ` → ${JSON.stringify(got[bucket])}` : ""),
      );
      return;
    }
  }
  ok(label);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

check("no change classifies as nothing", manifest(), manifest(), {});

check(
  "a removed subtype is BREAKING",
  manifest({ types: [type("field", "string"), type("field", "uri")] }),
  manifest({ types: [type("field", "string")] }),
  { breaking: 1 },
);

check(
  "an added subtype is ADDITIVE",
  manifest({ types: [type("field", "string")] }),
  manifest({ types: [type("field", "string"), type("field", "uri")] }),
  { additive: 1 },
);

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

const withAttrs = (...attrs) => manifest({ types: [type("field", "string", { attrs })] });

check("a removed attr is BREAKING", withAttrs(attr("a")), withAttrs(), { breaking: 1 });
check("an added OPTIONAL attr is ADDITIVE", withAttrs(), withAttrs(attr("a")), { additive: 1 });

// An attr that arrives already-required convicts every document that omits it — the
// registry grew, but existing metadata stopped loading.
check(
  "an added REQUIRED attr is BREAKING",
  withAttrs(),
  withAttrs(attr("a", { required: true })),
  { breaking: 1 },
);

check(
  "optional → required is BREAKING",
  withAttrs(attr("a")),
  withAttrs(attr("a", { required: true })),
  { breaking: 1 },
);
check(
  "required → optional is ADDITIVE",
  withAttrs(attr("a", { required: true })),
  withAttrs(attr("a")),
  { additive: 1 },
);
check(
  "a changed valueType is BREAKING",
  withAttrs(attr("a")),
  withAttrs(attr("a", { valueType: "int" })),
  { breaking: 1 },
);
check(
  "a changed isArray is BREAKING",
  withAttrs(attr("a")),
  withAttrs(attr("a", { isArray: true })),
  { breaking: 1 },
);

// ---------------------------------------------------------------------------
// allowedValues — the direction that is easiest to get backwards.
// ---------------------------------------------------------------------------

check(
  "an enum member REMOVED is BREAKING",
  withAttrs(attr("a", { allowedValues: ["x", "y"] })),
  withAttrs(attr("a", { allowedValues: ["x"] })),
  { breaking: 1 },
);
check(
  "an enum member ADDED is ADDITIVE",
  withAttrs(attr("a", { allowedValues: ["x"] })),
  withAttrs(attr("a", { allowedValues: ["x", "y"] })),
  { additive: 1 },
);
check(
  "an OPEN attr becoming a closed enum is BREAKING",
  withAttrs(attr("a")),
  withAttrs(attr("a", { allowedValues: ["x"] })),
  { breaking: 1 },
);
check(
  "a closed enum OPENING is ADDITIVE",
  withAttrs(attr("a", { allowedValues: ["x"] })),
  withAttrs(attr("a")),
  { additive: 1 },
);

// ---------------------------------------------------------------------------
// Child rules
// ---------------------------------------------------------------------------

const withKids = (...children) => manifest({ types: [type("object", "entity", { children })] });

check("a removed child rule is BREAKING", withKids(child("field")), withKids(), { breaking: 1 });
check("an added OPTIONAL child rule is ADDITIVE", withKids(), withKids(child("field")), {
  additive: 1,
});
check(
  "an added MANDATORY child rule is BREAKING",
  withKids(),
  withKids(child("field", { min: 1 })),
  { breaking: 1 },
);
check(
  "raising min is BREAKING",
  withKids(child("field")),
  withKids(child("field", { min: 1 })),
  { breaking: 1 },
);
check(
  "lowering min is ADDITIVE",
  withKids(child("field", { min: 1 })),
  withKids(child("field")),
  { additive: 1 },
);
// max: null means unbounded, so introducing ANY cap narrows.
check(
  "capping an unbounded max is BREAKING",
  withKids(child("field")),
  withKids(child("field", { max: 3 })),
  { breaking: 1 },
);
check(
  "lifting a cap is ADDITIVE",
  withKids(child("field", { max: 3 })),
  withKids(child("field")),
  { additive: 1 },
);
check(
  "lowering a finite max is BREAKING",
  withKids(child("field", { max: 3 })),
  withKids(child("field", { max: 2 })),
  { breaking: 1 },
);

// ---------------------------------------------------------------------------
// commonAttrs + defaultSubTypes
// ---------------------------------------------------------------------------

check(
  "a removed commonAttr is BREAKING",
  manifest({ commonAttrs: [attr("notes")] }),
  manifest({ commonAttrs: [] }),
  { breaking: 1 },
);
check(
  "a changed default subtype is BREAKING (it changes what an unqualified declaration MEANS)",
  manifest({ defaultSubTypes: { object: "entity" } }),
  manifest({ defaultSubTypes: { object: "value" } }),
  { breaking: 1 },
);
check(
  "a removed default subtype is BREAKING",
  manifest({ defaultSubTypes: { object: "entity" } }),
  manifest({ defaultSubTypes: {} }),
  { breaking: 1 },
);
check(
  "an added default subtype is ADDITIVE",
  manifest({ defaultSubTypes: {} }),
  manifest({ defaultSubTypes: { object: "entity" } }),
  { additive: 1 },
);

// ---------------------------------------------------------------------------
// Prose — reported, never classified. This is the gate's stated blind spot.
// ---------------------------------------------------------------------------

check(
  "a type description change is PROSE ONLY",
  manifest({ types: [type("field", "string", { description: "old" })] }),
  manifest({ types: [type("field", "string", { description: "new" })] }),
  { prose: 1 },
);
check(
  "a `rules` change is PROSE ONLY — this is exactly #210, and why prose only warns",
  manifest({ types: [type("object", "value", { rules: "populated by assembly" })] }),
  manifest({ types: [type("object", "value", { rules: "constructed, never assembled" })] }),
  { prose: 1 },
);
check(
  "an attr description change is PROSE ONLY",
  withAttrs(attr("a", { description: "old" })),
  withAttrs(attr("a", { description: "new" })),
  { prose: 1 },
);

// ---------------------------------------------------------------------------
// Required bump + satisfaction
// ---------------------------------------------------------------------------

const v = (s) => parseVersion(s, "test");

const bump = (sev, base) => requiredBump(sev, v(base));
if (bump("none", "1.0") !== "none") bad("no change requires no bump");
else ok("no change requires no bump");
if (bump("additive", "1.0") !== "minor") bad("additive requires a minor");
else ok("additive requires a minor");
if (bump("breaking", "1.0") !== "major") bad("post-1.0 breaking requires a major");
else ok("post-1.0 breaking requires a major");
// Pre-1.0 the major carries no promise, so a break moves the minor — the same rule the
// package line follows at 0.x, and the reason `0.21.0` was a legitimate breaking slot.
if (bump("breaking", "0.9") !== "minor") bad("pre-1.0 breaking requires a minor, not a major");
else ok("pre-1.0 breaking requires a minor, not a major");

// ── the correction path (docs/compatibility-policy.md, "Correcting input we wrongly
// accepted") ────────────────────────────────────────────────────────────────────────
//
// Post-1.0, `breaking → major` with no exception would make the project's most common
// change — refusing a form the loader never should have accepted — unshippable inside
// 1.x. `0.24.1` is the worked example: #342 and #335 each made a previously-loading form
// fail, and each moved the metamodel MINOR (0.11 → 0.12). The flag reproduces that, so a
// correction still moves the contract and still is not a Metamodel 2.0 event.
const corr = (sev, base) => requiredBump(sev, v(base), { correction: true });
if (corr("breaking", "1.0") !== "minor") bad("post-1.0 a correction requires a minor, NOT a major");
else ok("post-1.0 a correction requires a minor, NOT a major");
// It must never reach "none" — the metadata contract did change, so the number must move
// and the changelog must say so. A correction that demanded no bump would be invisible.
if (corr("breaking", "1.0") === "none") bad("a correction must still move the version");
else ok("a correction must still move the version");
// Pre-1.0 the flag is a no-op, which is why it can be added without reclassifying history.
if (corr("breaking", "0.9") !== bump("breaking", "0.9")) bad("pre-1.0 the correction flag changes nothing");
else ok("pre-1.0 the correction flag changes nothing");
// It cannot upgrade a lesser severity into a bump it did not earn.
if (corr("none", "1.0") !== "none") bad("a correction over `none` is still none");
else ok("a correction over `none` is still none");
if (corr("additive", "1.0") !== "minor") bad("a correction over `additive` is still a minor");
else ok("a correction over `additive` is still a minor");

const sat = (b, base, cur) => satisfies(b, v(base), v(cur));
if (sat("minor", "1.0", "1.0")) bad("an unmoved version must NOT satisfy a minor");
else ok("an unmoved version must NOT satisfy a minor");
if (!sat("minor", "1.0", "1.1")) bad("1.0 → 1.1 satisfies a minor");
else ok("1.0 → 1.1 satisfies a minor");
if (!sat("minor", "1.0", "2.0")) bad("a major over-satisfies a minor");
else ok("a major over-satisfies a minor");
if (sat("major", "1.0", "1.1")) bad("a minor must NOT satisfy a major");
else ok("a minor must NOT satisfy a major");
if (!sat("major", "1.0", "2.0")) bad("1.0 → 2.0 satisfies a major");
else ok("1.0 → 2.0 satisfies a major");
// "0.10" is numerically after "0.9" even though it sorts before it as a string — the
// classic two-digit-minor trap, and the exact step this gate first demanded.
if (!sat("minor", "0.9", "0.10")) bad("0.9 → 0.10 satisfies a minor (numeric, not lexical)");
else ok("0.9 → 0.10 satisfies a minor (numeric, not lexical)");
if (sat("minor", "0.10", "0.9")) bad("0.10 → 0.9 is a REGRESSION and must not satisfy");
else ok("0.10 → 0.9 is a REGRESSION and must not satisfy");
// CROSS-MAJOR regressions. `cur.major > base.major || cur.minor > base.minor` reads as
// "moved somehow" and accepts both of these — 0 > 1 is false, but 11 > 0 is true. The
// same-major case above passed under that bug, which is what made it look covered.
if (sat("minor", "1.0", "0.11")) bad("1.0 → 0.11 is a REGRESSION across majors and must not satisfy");
else ok("1.0 → 0.11 is a REGRESSION across majors and must not satisfy");
if (sat("minor", "2.0", "1.9")) bad("2.0 → 1.9 is a REGRESSION across majors and must not satisfy");
else ok("2.0 → 1.9 is a REGRESSION across majors and must not satisfy");
if (!sat("minor", "1.9", "2.0")) bad("1.9 → 2.0 moves forward across a major and satisfies a minor");
else ok("1.9 → 2.0 moves forward across a major and satisfies a minor");

console.log(fails === 0 ? "\nmetamodel-version classifier: all checks passed" : `\n${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
