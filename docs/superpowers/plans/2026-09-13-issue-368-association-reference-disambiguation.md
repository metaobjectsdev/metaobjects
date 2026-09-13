# Issue #368 — Association→Reference Disambiguation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an entity declares two or more `identity.reference` nodes targeting the same entity, each `relationship.*` with `@cardinality: one` must resolve to its *own* reference — explicitly via `@sourceRefField`, implicitly by name pairing, or fail to load naming the candidates — instead of silently taking the first match.

**Architecture:** One shared resolution helper in `@metaobjectsdev/metadata` implements a three-stage ladder (unique-candidate → `@sourceRefField` → name pairing). A new loader validation rule makes an unresolvable model a **load error** in all four ports, so `meta verify` catches it (ADR-0029 §5: "introducing a second path later is a load error naming the candidates"). The TypeScript consumers that currently do their own first-match lookup are re-pointed at the helper.

**Tech Stack:** TypeScript (Bun test runner), Java (JUnit/Maven), C# (xUnit/dotnet), Python (pytest); cross-port fixtures in `fixtures/conformance/`.

**Spec:** GitHub issue [#368](https://github.com/metaobjectsdev/metaobjects/issues/368) plus the design rulings recorded in "Design decisions" below.

---

## Global Constraints

- **No new metamodel vocabulary.** `@sourceRefField` is already registered on all four `relationship.*` subtypes in `fixtures/registry-conformance/expected-registry.json`. The attr *set* must not change, so `metamodelVersion` stays `"1.0"` (currently frozen). Task 9 asserts this.
- **ADR-0023 (strict provenance):** no invented attributes. Anything the loader accepts must already come from a registered provider.
- **ADR-0029 §5:** ambiguity is a **load error naming the candidates**, not a codegen-time guess and not silent inference beyond the specified rule.
- **ADR-0037 §65:** no same-name-different-meaning attrs. `@via` is reserved to `origin.*` and must NOT be used here.
- **ADR-0039 (own-accessor discipline):** use *resolving* accessors (`attr()`, `children()`, `referenceIdentities()`) everywhere. The one exception is validation iterating `ownChildren()` to validate the declaring entity — matching the existing rule-(d) loop.
- **Public repo hygiene:** no private project names, no absolute home paths in any committed file, including fixtures and commit messages.
- **TDD:** every task writes a failing test first and runs it to confirm the failure before implementing.
- **Error code:** `ERR_INVALID_RELATIONSHIP` (already defined at `server/typescript/packages/metadata/src/errors.ts:120`).

---

## Design decisions

These were settled before planning; executors must not re-litigate them.

**1. Why not derive it?** The FK *is* derived whenever exactly one `identity.reference` targets the relationship's `@objectRef` — that is today's behaviour and it stays. When two references target the same entity, `homeTeam` and `awayTeam` are *identical declarations* (`{@objectRef: "Team", @cardinality: "one"}`); the only distinguishing signal is the node's own name. Declaration-order pairing was rejected: it is the `views()[0]` failure of #356, and `meta fmt` (#304) would silently re-pair every join on a format run.

**2. Why `@sourceRefField` and not a new attr?** It is already registered on `relationship.association`/`aggregation`/`composition`/`base`, and on a `@cardinality: one` relationship it is currently a hard error ("sets @sourceRefField but is not a M:N relationship", `validation-passes.ts:2011`). Giving it meaning there is **strictly additive** — input that never had a valid meaning gains one — which is the `docs/compatibility-policy.md` correction bar, not a breaking change.

**3. The name-pairing rule (normative).** It is cross-port conformance surface, so it is specified exactly:

> Let `A` be the relationship's name. For each candidate reference `R` with first FK field `F`, build the **pairing key set**:
> `{ lower(R.name), strip(lower(R.name)), lower(F), strip(lower(F)) }`
> where `strip(s)` removes **one** trailing suffix from the ordered list `["reference", "ref", "id", "key"]` (first match wins; returns `s` unchanged if none match, and never returns the empty string — if stripping would empty the string, `s` is returned unchanged).
> `R` **name-matches** `A` iff `lower(A)` is in that set.
> The rule resolves **only** when exactly one candidate name-matches. Zero or two-or-more → error.

Suffixes are stripped from the *candidate* side only, never from `A`. This is deliberate: stripping `A` would let `valid` → `val` falsely pair with a `valRef`. Failing closed is correct — the rule may only ever *select*, never guess.

**4. Where the error surfaces.** Load/validation time in all four ports, so `meta verify` reports it. The issue's core complaint was that `meta verify` was clean while the output was wrong.

**5. Ports.** *Validation* is cross-port (TS/Java/C#/Python — Kotlin uses the Java metadata layer). *Resolution* is TypeScript-only, because only TS emits a forward `one()` navigation from the association node; Java/C#/Python enumerate references individually for their ADR-0038 finders. Task 8 verifies that claim rather than assuming it.

---

## File Structure

**Created:**
- `server/typescript/packages/metadata/src/core/relationship/resolve-relationship-reference.ts` — the resolution ladder + candidate enumeration. Single responsibility: given an entity and a 1:N relationship, say which `identity.reference` it navigates through.
- `server/typescript/packages/metadata/test/resolve-relationship-reference.test.ts` — unit tests for the ladder and the pairing rule.
- `fixtures/conformance/relationship-one-two-refs-sourcerefield/` — positive fixture, explicit disambiguation.
- `fixtures/conformance/relationship-one-two-refs-name-pairing/` — positive fixture, implicit pairing.
- `fixtures/conformance/error-relationship-one-refs-ambiguous/` — error envelope.

**Modified:**
- `server/typescript/packages/metadata/src/index.ts:117` — export the new helper.
- `server/typescript/packages/metadata/src/loader/validation-passes.ts:1994-2024` — widen rule (d); add rule (e).
- `server/typescript/packages/codegen-ts/src/relation-resolver.ts:95-101` — use the helper.
- `server/typescript/packages/runtime-ts/src/relation-resolver.ts:32-50` — use the helper.
- `server/typescript/packages/codegen-ts/src/projection/extract-view-spec.ts:760,1093` — ambiguity-aware lookup.
- `server/typescript/packages/metadata/src/core/relationship/find-reference.ts` — add plural `findReferencesBetween`.
- `server/typescript/packages/docs-site/src/link-graph.ts:105` — render all edges, not the first.
- `server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java:1741-1765`
- `server/csharp/MetaObjects/Loader/ValidationPasses.cs:3141-3160`
- `server/python/src/metaobjects/loader/validation_passes.py:2650-2670`
- `CHANGELOG.md`, `spec/decisions/ADR-0029-…md` (amendment note)

---

## Task 1: The resolution helper

**Files:**
- Create: `server/typescript/packages/metadata/src/core/relationship/resolve-relationship-reference.ts`
- Test: `server/typescript/packages/metadata/test/resolve-relationship-reference.test.ts`
- Modify: `server/typescript/packages/metadata/src/index.ts` (add exports after line 118)

**Interfaces:**
- Consumes: `MetaObject.referenceIdentities()`, `MetaReferenceIdentity.{name, fields, targetEntity}`, `stripPackage` from `../../naming.js`.
- Produces:
  - `referenceCandidatesFor(holder: MetaObject, targetEntity: string): MetaReferenceIdentity[]`
  - `resolveRelationshipReference(holder: MetaObject, relationshipName: string, targetEntity: string, sourceRefField?: string): MetaReferenceIdentity | undefined`
  - `referencePairingKeys(ref: MetaReferenceIdentity): Set<string>`

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/metadata/test/resolve-relationship-reference.test.ts
import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/loader.js";
import {
  referenceCandidatesFor,
  resolveRelationshipReference,
} from "../src/core/relationship/resolve-relationship-reference.js";
import type { MetaObject } from "../src/core/object/meta-object.js";

const MATCH_MODEL = {
  "metadata.root": {
    package: "repro",
    children: [
      {
        "object.entity": {
          name: "Team",
          children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Match",
          children: [
            { "field.int": { name: "id" } },
            { "field.int": { name: "homeTeamId" } },
            { "field.int": { name: "awayTeamId" } },
            { "identity.primary": { name: "id", "@fields": ["id"] } },
            { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
            { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
            { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
            { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one" } },
          ],
        },
      },
    ],
  },
};

function loadMatch(): MetaObject {
  const root = new MetaDataLoader().loadFromObject(MATCH_MODEL, "meta.repro.json");
  return root.findObject("Match")! as MetaObject;
}

describe("resolveRelationshipReference", () => {
  test("enumerates every candidate reference for the target", () => {
    const candidates = referenceCandidatesFor(loadMatch(), "Team");
    expect(candidates.map((r) => r.name)).toEqual(["homeTeamRef", "awayTeamRef"]);
  });

  test("name pairing resolves each association to its own reference", () => {
    const match = loadMatch();
    expect(resolveRelationshipReference(match, "homeTeam", "Team")?.name).toBe("homeTeamRef");
    expect(resolveRelationshipReference(match, "awayTeam", "Team")?.name).toBe("awayTeamRef");
  });

  test("@sourceRefField wins over name pairing", () => {
    const match = loadMatch();
    expect(
      resolveRelationshipReference(match, "homeTeam", "Team", "awayTeamId")?.name,
    ).toBe("awayTeamRef");
  });

  test("a single candidate resolves regardless of name", () => {
    const root = new MetaDataLoader().loadFromObject(
      {
        "metadata.root": {
          package: "repro",
          children: [
            { "object.entity": { name: "Team", children: [
              { "field.int": { name: "id" } },
              { "identity.primary": { name: "id", "@fields": ["id"] } },
            ] } },
            { "object.entity": { name: "Match", children: [
              { "field.int": { name: "id" } },
              { "field.int": { name: "winnerFk" } },
              { "identity.primary": { name: "id", "@fields": ["id"] } },
              { "identity.reference": { name: "anythingAtAll", "@fields": ["winnerFk"], "@references": "Team" } },
              { "relationship.association": { name: "champion", "@objectRef": "Team", "@cardinality": "one" } },
            ] } },
          ],
        },
      },
      "meta.repro.json",
    );
    const match = root.findObject("Match")! as MetaObject;
    expect(resolveRelationshipReference(match, "champion", "Team")?.name).toBe("anythingAtAll");
  });

  test("unpairable names return undefined rather than guessing", () => {
    const root = new MetaDataLoader().loadFromObject(
      {
        "metadata.root": {
          package: "repro",
          children: [
            { "object.entity": { name: "Team", children: [
              { "field.int": { name: "id" } },
              { "identity.primary": { name: "id", "@fields": ["id"] } },
            ] } },
            { "object.entity": { name: "Match", children: [
              { "field.int": { name: "id" } },
              { "field.int": { name: "alphaFk" } },
              { "field.int": { name: "betaFk" } },
              { "identity.primary": { name: "id", "@fields": ["id"] } },
              { "identity.reference": { name: "alphaRef", "@fields": ["alphaFk"], "@references": "Team" } },
              { "identity.reference": { name: "betaRef", "@fields": ["betaFk"], "@references": "Team" } },
              { "relationship.association": { name: "winner", "@objectRef": "Team", "@cardinality": "one" } },
            ] } },
          ],
        },
      },
      "meta.repro.json",
    );
    const match = root.findObject("Match")! as MetaObject;
    expect(resolveRelationshipReference(match, "winner", "Team")).toBeUndefined();
  });

  test("suffix stripping never applies to the relationship name", () => {
    // "valid" must NOT be stripped to "val" and pair with valRef.
    const root = new MetaDataLoader().loadFromObject(
      {
        "metadata.root": {
          package: "repro",
          children: [
            { "object.entity": { name: "Team", children: [
              { "field.int": { name: "id" } },
              { "identity.primary": { name: "id", "@fields": ["id"] } },
            ] } },
            { "object.entity": { name: "Match", children: [
              { "field.int": { name: "id" } },
              { "field.int": { name: "valFk" } },
              { "field.int": { name: "otherFk" } },
              { "identity.primary": { name: "id", "@fields": ["id"] } },
              { "identity.reference": { name: "valRef", "@fields": ["valFk"], "@references": "Team" } },
              { "identity.reference": { name: "otherRef", "@fields": ["otherFk"], "@references": "Team" } },
              { "relationship.association": { name: "valid", "@objectRef": "Team", "@cardinality": "one" } },
            ] } },
          ],
        },
      },
      "meta.repro.json",
    );
    const match = root.findObject("Match")! as MetaObject;
    expect(resolveRelationshipReference(match, "valid", "Team")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/resolve-relationship-reference.test.ts`
Expected: FAIL — `Cannot find module '../src/core/relationship/resolve-relationship-reference.js'`

> If `loadFromObject` is not the loader's in-memory entry point, find the one the neighbouring tests in `server/typescript/packages/metadata/test/` use (grep for `new MetaDataLoader()`), and use that in every test in this plan. Do not invent a loader API.

- [ ] **Step 3: Write the implementation**

```ts
// server/typescript/packages/metadata/src/core/relationship/resolve-relationship-reference.ts
// Association -> identity.reference resolution (issue #368).
//
// An entity may declare more than one identity.reference onto the SAME target
// entity (Match.homeTeamRef and Match.awayTeamRef both -> Team). A
// `@cardinality: one` relationship names only its target, so when two
// references match, the target alone cannot say which FK the navigation uses.
// Taking the first match emits a join on the wrong column that typechecks, has
// correct DDL and passes verify — so the ladder below resolves it explicitly or
// not at all. ADR-0029 §5: ambiguity is a load error naming the candidates.

import type { MetaObject } from "../object/meta-object.js";
import type { MetaReferenceIdentity } from "../identity/meta-identity.js";
import { stripPackage } from "../../naming.js";

/**
 * Trailing suffixes stripped from a CANDIDATE's name/FK field when building its
 * pairing keys. Ordered — first match wins, so "reference" is tested before
 * "ref". Never applied to the relationship name (see referencePairingKeys).
 */
const PAIRING_SUFFIXES = ["reference", "ref", "id", "key"] as const;

function stripOneSuffix(value: string): string {
  for (const suffix of PAIRING_SUFFIXES) {
    if (value.length > suffix.length && value.endsWith(suffix)) {
      return value.slice(0, value.length - suffix.length);
    }
  }
  return value;
}

/** The FK field a reference is anchored on (first field; composite FKs pair on their first column). */
function refFkField(ref: MetaReferenceIdentity): string | undefined {
  return ref.fields.length > 0 ? ref.fields[0] : undefined;
}

/**
 * The set of lowercased names a candidate reference answers to: its own name
 * and its FK field, each with and without one stripped suffix.
 */
export function referencePairingKeys(ref: MetaReferenceIdentity): Set<string> {
  const keys = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    const lower = value.toLowerCase();
    keys.add(lower);
    keys.add(stripOneSuffix(lower));
  };
  add(ref.name);
  add(refFkField(ref));
  return keys;
}

/**
 * Every identity.reference on `holder` whose @references targets `targetEntity`.
 * Package-insensitive on both sides: @references and @objectRef may each be bare
 * or fully qualified.
 */
export function referenceCandidatesFor(
  holder: MetaObject,
  targetEntity: string,
): MetaReferenceIdentity[] {
  const target = stripPackage(targetEntity);
  // ADR-0039: resolving — referenceIdentities() honors references inherited via extends.
  return holder
    .referenceIdentities()
    .filter((ref) => stripPackage(ref.targetEntity ?? "") === target)
    .filter((ref) => refFkField(ref) !== undefined);
}

/**
 * Which identity.reference does this `@cardinality: one` relationship navigate
 * through? The ladder, in order:
 *
 *   1. exactly one candidate            -> that one (the common case; unchanged behaviour)
 *   2. `@sourceRefField` declared       -> the candidate whose FK field it names
 *   3. exactly one candidate name-pairs -> that one
 *   4. otherwise                        -> undefined (caller reports the ambiguity)
 *
 * Returns undefined for "no candidate" and "cannot choose" alike; callers that
 * need to tell them apart use referenceCandidatesFor().
 */
export function resolveRelationshipReference(
  holder: MetaObject,
  relationshipName: string,
  targetEntity: string,
  sourceRefField?: string,
): MetaReferenceIdentity | undefined {
  const candidates = referenceCandidatesFor(holder, targetEntity);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  if (sourceRefField !== undefined && sourceRefField !== "") {
    return candidates.find((ref) => refFkField(ref) === sourceRefField);
  }

  const wanted = relationshipName.toLowerCase();
  const paired = candidates.filter((ref) => referencePairingKeys(ref).has(wanted));
  return paired.length === 1 ? paired[0] : undefined;
}
```

- [ ] **Step 4: Export from the package barrel**

In `server/typescript/packages/metadata/src/index.ts`, immediately after line 118 (`export type { ReferenceLookup } …`):

```ts
export {
  referenceCandidatesFor,
  referencePairingKeys,
  resolveRelationshipReference,
} from "./core/relationship/resolve-relationship-reference.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server/typescript/packages/metadata && bun test test/resolve-relationship-reference.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 6: Typecheck**

Run: `cd server/typescript/packages/metadata && bun run build && bun run typecheck`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/metadata/src/core/relationship/resolve-relationship-reference.ts \
        server/typescript/packages/metadata/test/resolve-relationship-reference.test.ts \
        server/typescript/packages/metadata/src/index.ts
git commit -m "feat(metadata): association->reference resolution ladder (#368)"
```

---

## Task 2: Widen rule (d) — `@sourceRefField` legal on `@cardinality: one`

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/validation-passes.ts:2010-2016`
- Test: `server/typescript/packages/metadata/test/relationship-m2m-validation.test.ts` (append; if that file does not exist, grep `test/` for the file asserting "is not a M:N relationship" and append there)

**Interfaces:**
- Consumes: `RELATIONSHIP_ATTR_SOURCE_REF_FIELD`, `CARDINALITY_ONE` (already imported in this file).
- Produces: no new exports. Behavioural change only: `@sourceRefField` + `@cardinality: one` loads clean; `@sourceRefField` with any other non-M:N cardinality still errors.

- [ ] **Step 1: Write the failing test**

```ts
test("@sourceRefField is legal on a cardinality:one relationship (#368)", () => {
  const result = loadExpectingErrors({
    "metadata.root": {
      package: "repro",
      children: [
        { "object.entity": { name: "Team", children: [
          { "field.int": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
        ] } },
        { "object.entity": { name: "Match", children: [
          { "field.int": { name: "id" } },
          { "field.int": { name: "homeTeamId" } },
          { "field.int": { name: "awayTeamId" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
          { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
          { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
          { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "homeTeamId" } },
          { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "awayTeamId" } },
        ] } },
      ],
    },
  });
  expect(result.errors).toEqual([]);
});

test("@sourceRefField on a non-M:N, non-one relationship still errors", () => {
  const result = loadExpectingErrors({
    "metadata.root": {
      package: "repro",
      children: [
        { "object.entity": { name: "Team", children: [
          { "field.int": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
        ] } },
        { "object.entity": { name: "Match", children: [
          { "field.int": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
          { "relationship.association": { name: "teams", "@objectRef": "Team", "@cardinality": "many", "@sourceRefField": "whatever" } },
        ] } },
      ],
    },
  });
  expect(result.errors.map((e) => e.code)).toContain("ERR_INVALID_RELATIONSHIP");
});
```

> Match the surrounding file's loader helper (grep it for `loadExpectingErrors` or equivalent) rather than introducing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test -t "sourceRefField is legal"`
Expected: FAIL — one `ERR_INVALID_RELATIONSHIP` ("sets @sourceRefField but is not a M:N relationship") per association

- [ ] **Step 3: Implement**

In the `if (!isM2M) { … }` block, replace the `if (hasSourceRefField) { … }` clause with:

```ts
        // #368: @sourceRefField also disambiguates a `@cardinality: one`
        // relationship when the entity holds more than one identity.reference
        // onto the same target. Only the M:N *junction* reading is rejected
        // here; rule (e) below checks that it names a real local reference.
        if (hasSourceRefField && cardinality !== CARDINALITY_ONE) {
          errors.push(
            new ParseError(
              `relationship "${obj.name}.${rel.name}" sets @${RELATIONSHIP_ATTR_SOURCE_REF_FIELD} but is not a M:N relationship.`,
              { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
            ),
          );
        }
```

Then change the `continue;` that closes the `!isM2M` block so a `cardinality: one` relationship falls through to rule (e) in Task 3 rather than skipping validation. The simplest shape that preserves existing behaviour: keep `continue;` for now and add rule (e) as its own loop in Task 3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server/typescript/packages/metadata && bun test test/relationship-m2m-validation.test.ts`
Expected: PASS, including every pre-existing test in the file

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/loader/validation-passes.ts \
        server/typescript/packages/metadata/test/relationship-m2m-validation.test.ts
git commit -m "feat(loader): @sourceRefField is legal on cardinality:one (#368)"
```

---

## Task 3: Rule (e) — unresolvable 1:N reference is a load error (TypeScript)

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/validation-passes.ts` (new pass, placed immediately after the M:N slim-vocabulary pass)
- Test: same file as Task 2

**Interfaces:**
- Consumes: `referenceCandidatesFor`, `resolveRelationshipReference` from Task 1.
- Produces: `ERR_INVALID_RELATIONSHIP` whose message names the entity, the relationship, and every candidate as `name(fkField)`.

- [ ] **Step 1: Write the failing test**

```ts
test("two references to one target with an unpairable relationship name is a load error (#368)", () => {
  const result = loadExpectingErrors({
    "metadata.root": {
      package: "repro",
      children: [
        { "object.entity": { name: "Team", children: [
          { "field.int": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
        ] } },
        { "object.entity": { name: "Match", children: [
          { "field.int": { name: "id" } },
          { "field.int": { name: "alphaFk" } },
          { "field.int": { name: "betaFk" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
          { "identity.reference": { name: "alphaRef", "@fields": ["alphaFk"], "@references": "Team" } },
          { "identity.reference": { name: "betaRef", "@fields": ["betaFk"], "@references": "Team" } },
          { "relationship.association": { name: "winner", "@objectRef": "Team", "@cardinality": "one" } },
        ] } },
      ],
    },
  });
  expect(result.errors.map((e) => e.code)).toContain("ERR_INVALID_RELATIONSHIP");
  const message = result.errors.map((e) => e.message).join("\n");
  expect(message).toContain("Match.winner");
  expect(message).toContain("alphaRef(alphaFk)");
  expect(message).toContain("betaRef(betaFk)");
});

test("the issue #368 repro loads clean via name pairing", () => {
  const result = loadExpectingErrors({
    "metadata.root": {
      package: "repro",
      children: [
        { "object.entity": { name: "Team", children: [
          { "field.int": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
        ] } },
        { "object.entity": { name: "Match", children: [
          { "field.int": { name: "id" } },
          { "field.int": { name: "homeTeamId" } },
          { "field.int": { name: "awayTeamId" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
          { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
          { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
          { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
          { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one" } },
        ] } },
      ],
    },
  });
  expect(result.errors).toEqual([]);
});

test("@sourceRefField naming no local reference is a load error", () => {
  const result = loadExpectingErrors({
    "metadata.root": {
      package: "repro",
      children: [
        { "object.entity": { name: "Team", children: [
          { "field.int": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
        ] } },
        { "object.entity": { name: "Match", children: [
          { "field.int": { name: "id" } },
          { "field.int": { name: "homeTeamId" } },
          { "field.int": { name: "awayTeamId" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
          { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
          { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
          { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "nonesuch" } },
          { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "awayTeamId" } },
        ] } },
      ],
    },
  });
  expect(result.errors.map((e) => e.code)).toContain("ERR_INVALID_RELATIONSHIP");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test -t "#368"`
Expected: FAIL — `result.errors` is empty for the ambiguous cases (that is the bug)

- [ ] **Step 3: Implement rule (e)**

Add this pass alongside the M:N pass in `validation-passes.ts`, and register it wherever the M:N pass is registered (grep for the function name of the pass containing rule (d) and mirror its registration):

```ts
// Rule (e) — #368: a `@cardinality: one` relationship must resolve to exactly one
// identity.reference. Two references onto the same target are indistinguishable
// from the relationship's @objectRef alone, so the resolver would silently emit
// the first one's FK column. ADR-0029 §5: a second path is a load error naming
// the candidates.
function validateOneSideReferenceResolution(root: MetaRoot): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.objects()) {
    // ADR-0039: own — a relationship is validated on the entity that DECLARES it.
    for (const rel of obj.ownChildren().filter((c) => c.type === TYPE_RELATIONSHIP)) {
      // ADR-0039: resolving — @cardinality/@objectRef may be inherited via extends.
      if (rel.attr(RELATIONSHIP_ATTR_CARDINALITY) !== CARDINALITY_ONE) continue;
      const objectRef = rel.attr(RELATIONSHIP_ATTR_OBJECT_REF);
      if (typeof objectRef !== "string" || objectRef === "") continue;

      const candidates = referenceCandidatesFor(obj as MetaObject, objectRef);
      if (candidates.length <= 1) continue;

      const sourceRefField = rel.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD);
      const declared = typeof sourceRefField === "string" && sourceRefField !== ""
        ? sourceRefField
        : undefined;
      const resolved = resolveRelationshipReference(
        obj as MetaObject, rel.name, objectRef, declared,
      );
      if (resolved) continue;

      const listed = candidates
        .map((c) => `${c.name}(${c.fields[0]})`)
        .join(", ");
      errors.push(
        new ParseError(
          declared !== undefined
            ? `relationship "${obj.name}.${rel.name}" sets @${RELATIONSHIP_ATTR_SOURCE_REF_FIELD} ` +
              `"${declared}", which names no identity.reference targeting "${objectRef}". ` +
              `Candidates: ${listed}.`
            : `relationship "${obj.name}.${rel.name}" is ambiguous: "${obj.name}" declares ` +
              `${candidates.length} identity.reference nodes targeting "${objectRef}" and the ` +
              `relationship name does not pair with exactly one. Candidates: ${listed}. ` +
              `Set @${RELATIONSHIP_ATTR_SOURCE_REF_FIELD} to the FK field this relationship navigates.`,
          { code: "ERR_INVALID_RELATIONSHIP", source: rel.source },
        ),
      );
    }
  }
  return errors;
}
```

Add the imports at the top of `validation-passes.ts`:

```ts
import {
  referenceCandidatesFor,
  resolveRelationshipReference,
} from "../core/relationship/resolve-relationship-reference.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server/typescript/packages/metadata && bun test`
Expected: PASS — the whole metadata suite, not just the new tests

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/loader/validation-passes.ts \
        server/typescript/packages/metadata/test/relationship-m2m-validation.test.ts
git commit -m "feat(loader): ambiguous 1:N reference is a load error (#368)"
```

---

## Task 4: codegen-ts relation resolver — the reported defect

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/relation-resolver.ts:95-101`
- Test: `server/typescript/packages/codegen-ts/test/relation-resolver-two-refs.test.ts` (create)

**Interfaces:**
- Consumes: `resolveRelationshipReference` from Task 1 (via `@metaobjectsdev/metadata`).
- Produces: `RelationEntry.fkField` now the relationship's *own* FK.

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/codegen-ts/test/relation-resolver-two-refs.test.ts
import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { buildRelationMap } from "../src/relation-resolver.js";

describe("buildRelationMap with two references onto one target (#368)", () => {
  test("each association joins on its own FK column", () => {
    const root = new MetaDataLoader().loadFromObject(
      {
        "metadata.root": {
          package: "repro",
          children: [
            { "object.entity": { name: "Team", children: [
              { "source.rdb": { "@table": "team" } },
              { "field.int": { name: "id" } },
              { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
            ] } },
            { "object.entity": { name: "Match", children: [
              { "source.rdb": { "@table": "match" } },
              { "field.int": { name: "id" } },
              { "field.int": { name: "homeTeamId", "@column": "home_team_id" } },
              { "field.int": { name: "awayTeamId", "@column": "away_team_id" } },
              { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
              { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
              { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
              { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
              { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one" } },
            ] } },
          ],
        },
      },
      "meta.repro.json",
    );

    const relations = buildRelationMap(root).get("Match")!;
    const byName = Object.fromEntries(relations.map((r) => [r.name, r.fkField]));
    expect(byName.homeTeam).toBe("homeTeamId");
    expect(byName.awayTeam).toBe("awayTeamId"); // was "homeTeamId" — the #368 defect
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/relation-resolver-two-refs.test.ts`
Expected: FAIL — `expect(byName.awayTeam).toBe("awayTeamId")` receives `"homeTeamId"`

- [ ] **Step 3: Implement**

Replace lines 95-101 of `relation-resolver.ts`:

```ts
      // #368: an entity may hold more than one identity.reference onto the same
      // target, so the target alone does not identify the FK. Resolve through the
      // shared ladder (unique candidate -> @sourceRefField -> name pairing); the
      // loader has already refused anything it cannot resolve, so a miss here
      // means an unloadable model reached codegen — skip rather than guess.
      // ADR-0039: resolving — @sourceRefField may be inherited via extends.
      const declaredRefField = child.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD) as string | undefined;
      const matching = resolveRelationshipReference(
        obj, child.name, targetEntity, declaredRefField,
      );
      if (!matching) continue;

      const fkField = matching.fields[0];
      if (!fkField) continue;
```

Add to the existing import block from `@metaobjectsdev/metadata`:

```ts
  RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
  resolveRelationshipReference,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server/typescript/packages/codegen-ts && bun test`
Expected: PASS — full codegen-ts suite

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/relation-resolver.ts \
        server/typescript/packages/codegen-ts/test/relation-resolver-two-refs.test.ts
git commit -m "fix(codegen-ts): relations() joined every association on the first FK (#368)"
```

---

## Task 5: runtime-ts relation resolver

**Files:**
- Modify: `server/typescript/packages/runtime-ts/src/relation-resolver.ts:32-50,80`
- Test: `server/typescript/packages/runtime-ts/test/relation-resolver-two-refs.test.ts` (create)

**Interfaces:**
- Consumes: `resolveRelationshipReference` from Task 1.
- Produces: `RelationDescriptor.sourceField` now the relationship's own FK.

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/runtime-ts/test/relation-resolver-two-refs.test.ts
import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { resolveRelationDescriptor } from "../src/relation-resolver.js";

const MODEL = {
  "metadata.root": {
    package: "repro",
    children: [
      { "object.entity": { name: "Team", children: [
        { "source.rdb": { "@table": "team" } },
        { "field.int": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": ["id"] } },
      ] } },
      { "object.entity": { name: "Match", children: [
        { "source.rdb": { "@table": "match" } },
        { "field.int": { name: "id" } },
        { "field.int": { name: "homeTeamId" } },
        { "field.int": { name: "awayTeamId" } },
        { "identity.primary": { name: "id", "@fields": ["id"] } },
        { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
        { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one" } },
      ] } },
    ],
  },
};

describe("resolveRelationDescriptor with two references onto one target (#368)", () => {
  test("each relation reads its own FK field", () => {
    const root = new MetaDataLoader().loadFromObject(MODEL, "meta.repro.json");
    const match = root.findObject("Match")!;
    expect(resolveRelationDescriptor(match, "homeTeam", root).sourceField).toBe("homeTeamId");
    expect(resolveRelationDescriptor(match, "awayTeam", root).sourceField).toBe("awayTeamId");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/runtime-ts && bun test test/relation-resolver-two-refs.test.ts`
Expected: FAIL — `awayTeam` resolves `sourceField` to `"homeTeamId"`

- [ ] **Step 3: Implement**

Replace the body of `findReferenceFkField` (lines 32-50) so it delegates, and pass the relationship through. Change its signature and both call sites:

```ts
/**
 * The FK field a `@cardinality: one` relationship navigates through.
 * #368: an entity may declare several identity.reference nodes onto the same
 * target, so the target alone is not enough — resolve through the shared ladder.
 */
function findReferenceFkField(
  holder: MetaData,
  targetName: string,
  relationshipName: string,
  sourceRefField?: string,
): string | undefined {
  const ref = resolveRelationshipReference(
    holder as unknown as MetaObject, relationshipName, targetName, sourceRefField,
  );
  return ref?.fields[0];
}
```

At the one-side call site (line 80):

```ts
    // ADR-0039: resolving — @sourceRefField may be inherited via extends.
    const declaredRefField = child.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD) as string | undefined;
    const fkField = findReferenceFkField(sourceEntity, targetEntityName, child.name, declaredRefField);
```

At the many-side call site (line 117), the FK lives on the *other* entity and belongs to that entity's relationship `child`:

```ts
      const declaredRefField = child.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD) as string | undefined;
      const fkField = findReferenceFkField(other, sourceEntity.name, child.name, declaredRefField);
```

Add `MetaObject`, `RELATIONSHIP_ATTR_SOURCE_REF_FIELD` and `resolveRelationshipReference` to the `@metaobjectsdev/metadata` import block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server/typescript/packages/runtime-ts && bun test`
Expected: PASS — full runtime-ts suite

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/runtime-ts/src/relation-resolver.ts \
        server/typescript/packages/runtime-ts/test/relation-resolver-two-refs.test.ts
git commit -m "fix(runtime-ts): relation traversal read the first FK for every relation (#368)"
```

---

## Task 6: `findReferenceBetween` ambiguity + docs link graph

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/relationship/find-reference.ts`
- Modify: `server/typescript/packages/metadata/src/index.ts` (export the plural)
- Modify: `server/typescript/packages/codegen-ts/src/projection/extract-view-spec.ts:760,1093`
- Modify: `server/typescript/packages/docs-site/src/link-graph.ts:105`
- Test: `server/typescript/packages/metadata/test/find-reference-ambiguity.test.ts` (create)

**Interfaces:**
- Produces: `findReferencesBetween(a: MetaObject, b: MetaObject): ReferenceLookup[]` — every match, `a` walked first. `findReferenceBetween` keeps its exact signature and first-match behaviour for compatibility.

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/metadata/test/find-reference-ambiguity.test.ts
import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/loader.js";
import { findReferenceBetween, findReferencesBetween } from "../src/core/relationship/find-reference.js";
import type { MetaObject } from "../src/core/object/meta-object.js";

describe("findReferencesBetween (#368)", () => {
  test("returns every reference, not just the first", () => {
    const root = new MetaDataLoader().loadFromObject(
      {
        "metadata.root": {
          package: "repro",
          children: [
            { "object.entity": { name: "Team", children: [
              { "field.int": { name: "id" } },
              { "identity.primary": { name: "id", "@fields": ["id"] } },
            ] } },
            { "object.entity": { name: "Match", children: [
              { "field.int": { name: "id" } },
              { "field.int": { name: "homeTeamId" } },
              { "field.int": { name: "awayTeamId" } },
              { "identity.primary": { name: "id", "@fields": ["id"] } },
              { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
              { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
            ] } },
          ],
        },
      },
      "meta.repro.json",
    );
    const match = root.findObject("Match")! as MetaObject;
    const team = root.findObject("Team")! as MetaObject;

    const all = findReferencesBetween(match, team);
    expect(all.map((r) => r.referenceIdentity.name)).toEqual(["homeTeamRef", "awayTeamRef"]);

    // Back-compat: the singular still answers with the first.
    expect(findReferenceBetween(match, team)?.referenceIdentity.name).toBe("homeTeamRef");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/find-reference-ambiguity.test.ts`
Expected: FAIL — `findReferencesBetween` is not exported

- [ ] **Step 3: Implement**

In `find-reference.ts`, add above `findReferenceBetween`:

```ts
/**
 * Every identity.reference on `a` or `b` targeting the other side, `a` walked
 * first. #368: two references onto the same entity are legal, so callers that
 * must not guess enumerate here and report ambiguity themselves.
 */
export function findReferencesBetween(
  a: MetaObject,
  b: MetaObject,
): ReferenceLookup[] {
  const found: ReferenceLookup[] = [];
  for (const [holder, other] of [[a, b], [b, a]] as const) {
    for (const ref of holder.referenceIdentities()) {
      if (stripPackage(ref.targetEntity) === other.name) {
        found.push({ holder, other, referenceIdentity: ref });
      }
    }
  }
  return found;
}
```

and rewrite `findReferenceBetween` to delegate, keeping its documented first-match contract:

```ts
export function findReferenceBetween(
  a: MetaObject,
  b: MetaObject,
): ReferenceLookup | undefined {
  return findReferencesBetween(a, b)[0];
}
```

Export `findReferencesBetween` from `src/index.ts` beside the existing `findReferenceBetween` export (line 117).

At `extract-view-spec.ts:760` and `:1093`, replace each `findReferenceBetween(...)` call with the plural form and refuse ambiguity instead of silently taking `[0]`:

```ts
        const refs = findReferencesBetween(currentObj as MetaObject, target);
        if (refs.length > 1) {
          throw new Error(
            `projection join from "${(currentObj as MetaObject).name}" to "${target.name}" is ambiguous: ` +
              `${refs.map((r) => r.referenceIdentity.name).join(", ")}. ` +
              `Declare the hop explicitly with @via.`,
          );
        }
        const ref = refs[0];
```

At `link-graph.ts:105`, replace the `.find(...)` with a filter so the docs graph draws every edge:

```ts
          const matches = obj.referenceIdentities().filter((r) => stripPackage(r.targetEntity ?? "") === target);
```

then emit one edge per match (adapt the surrounding loop; the existing single-`match` body becomes the loop body).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server/typescript && bun run --filter '*' build && bun test`
Expected: PASS across packages

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/metadata/src/core/relationship/find-reference.ts \
        server/typescript/packages/metadata/src/index.ts \
        server/typescript/packages/metadata/test/find-reference-ambiguity.test.ts \
        server/typescript/packages/codegen-ts/src/projection/extract-view-spec.ts \
        server/typescript/packages/docs-site/src/link-graph.ts
git commit -m "fix(metadata,codegen-ts,docs): enumerate references instead of taking the first (#368)"
```

---

## Task 7: Cross-port validation parity (Java, C#, Python)

Each port gets the *same two changes* as Tasks 2+3: widen the `@sourceRefField` rejection to spare `@cardinality: one`, and add rule (e). Port the ladder from Task 1 verbatim — same suffix list, same order, same "candidate side only" stripping.

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java:1741-1765`
- Create: `server/java/metadata/src/main/java/com/metaobjects/relationship/RelationshipReferences.java`
- Modify: `server/csharp/MetaObjects/Loader/ValidationPasses.cs:3141-3160`
- Create: `server/csharp/MetaObjects/Core/Relationship/RelationshipReferences.cs`
- Modify: `server/python/src/metaobjects/loader/validation_passes.py:2650-2670`
- Create: `server/python/src/metaobjects/meta/core/relationship/relationship_references.py`
- Test: one test per port, mirroring Task 3's three cases (ambiguous → error; repro → clean; bad `@sourceRefField` → error). Place them beside each port's existing M:N validation tests — Java `server/java/metadata/src/test/java/com/metaobjects/relationship/M2MSlimVocabularyTest.java` is the model.

**Interfaces:**
- Produces, in each port, the equivalents of `referenceCandidatesFor` and `resolveRelationshipReference` with identical semantics. Message text must match the TS wording so the conformance error envelopes agree on `code` (envelopes assert `code` + `source`, not message text — but keep them aligned anyway).

- [ ] **Step 1: Write the failing test in each port**

Mirror Task 3's three test cases. Use each port's existing loader-error test helper; do not introduce a new one.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd server/java   && mvn -q -pl metadata test -Dtest=M2MSlimVocabularyTest
cd server/csharp && dotnet test --filter FullyQualifiedName~Relationship
cd server/python && python -m pytest tests/ -k "relationship and (ambiguous or sourceref)" -v
```
Expected: FAIL — no error is raised for the ambiguous model

- [ ] **Step 3: Implement the ladder + rule (e) in each port**

Port `resolve-relationship-reference.ts` (Task 1, Step 3) to each language, keeping `PAIRING_SUFFIXES = ["reference", "ref", "id", "key"]` in that order and stripping only on the candidate side. Then apply the Task 2 widening and add the Task 3 pass.

Python note (ADR-0039 naming inversion): Python's `attr()` is OWN — use `get_meta_attr()` for resolving reads, matching the surrounding code in `validation_passes.py`.

- [ ] **Step 4: Run the per-port suites to verify they pass**

```bash
cd server/java   && mvn -q -pl metadata test
cd server/csharp && dotnet test
cd server/python && python -m pytest tests/ -q
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/java server/csharp server/python
git commit -m "feat(java,csharp,python): 1:N reference resolution parity (#368)"
```

---

## Task 8: Verify no other port resolves forward 1:N by target alone

**Files:** none modified unless the audit finds a defect.

- [ ] **Step 1: Audit each port's forward-relation emit**

```bash
cd <repo-root>
grep -rn "referenceIdentities\|reference_identities\|ReferenceIdentities" \
  --include=*.java --include=*.cs --include=*.py server/ | grep -v test
```

For every hit that resolves a FK from a *relationship* (as opposed to enumerating references for ADR-0038 finders), check whether it filters by target only and takes the first. `server/python/src/metaobjects/codegen/generators/router_generator.py` (`reverse_fks_for`) and `server/java/.../M2MFields.java` were already reviewed during planning and are **correct** — they enumerate each reference individually.

- [ ] **Step 2: Record the finding**

If every port is clean, add one line to the PR description saying so. If a port is not clean, fix it with the same ladder and a test, in its own commit.

- [ ] **Step 3: Commit (only if a fix was needed)**

```bash
git commit -m "fix(<port>): forward 1:N reference resolution (#368)"
```

---

## Task 9: Conformance fixtures + registry invariant

**Files:**
- Create: `fixtures/conformance/relationship-one-two-refs-sourcerefield/{input/meta.sport.json,expected.json}`
- Create: `fixtures/conformance/relationship-one-two-refs-name-pairing/{input/meta.sport.json,expected.json}`
- Create: `fixtures/conformance/error-relationship-one-refs-ambiguous/{input/meta.sport.json,expected-errors.json}`

**Interfaces:**
- Consumes: the fixture format at `fixtures/conformance/error-relationship-symmetric-and-sourceref/` (error) and `fixtures/conformance/relationship-m2m-hetero/` (positive).

- [ ] **Step 1: Write the error fixture**

`fixtures/conformance/error-relationship-one-refs-ambiguous/input/meta.sport.json`:

```json
{
  "metadata.root": {
    "package": "acme::sport",
    "children": [
      {
        "object.entity": {
          "name": "Team",
          "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Match",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "alphaFk" } },
            { "field.long": { "name": "betaFk" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "alphaRef", "@fields": "alphaFk", "@references": "acme::sport::Team" } },
            { "identity.reference": { "name": "betaRef", "@fields": "betaFk", "@references": "acme::sport::Team" } },
            { "relationship.association": { "name": "winner", "@cardinality": "one", "@objectRef": "acme::sport::Team" } }
          ]
        }
      }
    ]
  }
}
```

`expected-errors.json`:

```json
{
  "errors": [
    {
      "code": "ERR_INVALID_RELATIONSHIP",
      "source": {
        "format": "json",
        "files": ["meta.sport.json"],
        "jsonPath": "$['metadata.root'].children[1]['object.entity'].children[6]['relationship.association']"
      }
    }
  ],
  "warnings": []
}
```

- [ ] **Step 2: Write the two positive fixtures**

Same two entities. For `relationship-one-two-refs-sourcerefield`, `Match` declares both references plus two associations carrying `"@sourceRefField": "alphaFk"` and `"@sourceRefField": "betaFk"`. For `relationship-one-two-refs-name-pairing`, use the issue's `homeTeamId`/`awayTeamId` + `homeTeamRef`/`awayTeamRef` + `homeTeam`/`awayTeam` shape with no `@sourceRefField`. Generate each `expected.json` the way the other positive fixtures do — run the TS conformance runner in update mode if one exists (`grep -rn "update\|--write" server/typescript/packages/metadata/test/conformance*`), otherwise hand-write it to match the canonical serializer output of a neighbouring fixture.

- [ ] **Step 3: Run the conformance corpus in every port**

```bash
cd server/typescript && bun test -t conformance
cd server/java      && mvn -q -pl metadata test -Dtest=*Conformance*
cd server/csharp    && dotnet test --filter FullyQualifiedName~Conformance
cd server/python    && python -m pytest tests/conformance -q
```
Expected: PASS in all four

- [ ] **Step 4: Assert the registry did NOT change**

```bash
git diff --exit-code fixtures/registry-conformance/expected-registry.json
```
Expected: exit 0, no output. **If this prints a diff, stop** — the change has grown a vocabulary cost it was designed to avoid, and that needs a ruling before going further.

- [ ] **Step 5: Commit**

```bash
git add fixtures/conformance/relationship-one-two-refs-sourcerefield \
        fixtures/conformance/relationship-one-two-refs-name-pairing \
        fixtures/conformance/error-relationship-one-refs-ambiguous
git commit -m "test(conformance): 1:N reference disambiguation fixtures (#368)"
```

---

## Task 10: Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `spec/decisions/ADR-0029-entity-child-extends-and-via-inference.md` (amendment)
- Modify: `CLAUDE.md:526` (the relationship-subtypes bullet)
- Modify: `docs/features/` — whichever page documents relationships (grep for `@sourceRefField`)

- [ ] **Step 1: Add the ADR-0029 amendment**

Append to ADR-0029:

```markdown
## Amendment 1 (2026-09-13) — the ambiguity rule extends to 1:N FK selection

§5's contract ("a second path is a load error naming the candidates") was stated
for `@via` on `origin.*`. Issue #368 found the same ambiguity one level down: two
`identity.reference` nodes onto the same target make a `@cardinality: one`
relationship's FK unresolvable from `@objectRef` alone, and the TypeScript
resolvers silently took the first.

The rule now also covers 1:N FK selection, resolved by this ladder:

1. exactly one candidate reference → that one;
2. `@sourceRefField` declared → the candidate whose FK field it names;
3. exactly one candidate name-pairs with the relationship name → that one;
4. otherwise → `ERR_INVALID_RELATIONSHIP` naming every candidate.

Stage 3 is a **local string rule**, not a graph walk: a candidate's pairing keys
are its own name and its FK field, each lowercased with and without one trailing
suffix from `["reference", "ref", "id", "key"]`. Suffixes are stripped from the
candidate side only. This keeps §5's "trivially portable" bar — it is pure string
comparison over one entity's own children, not the multi-hop path inference §5
declined to attempt.

No new vocabulary: `@sourceRefField` was already registered on every
`relationship.*` subtype, and on `@cardinality: one` it previously failed to
load, so giving it meaning is additive under the `docs/compatibility-policy.md`
correction bar. `metamodelVersion` is unchanged.
```

- [ ] **Step 2: Update `CLAUDE.md:526`**

Extend the `@sourceRefField` sentence in the relationship-subtypes bullet:

```
`@sourceRefField` (optional) disambiguates a *directed* self-join by naming the source-side FK field on the junction (the other reference is the target side); on a `@cardinality: one` relationship it names which of several `identity.reference` nodes onto the same target this relationship navigates (#368, ADR-0029 Amendment 1) — an unresolvable 1:N reference is `ERR_INVALID_RELATIONSHIP` at load.
```

- [ ] **Step 3: Add the CHANGELOG entry**

Under the unreleased heading, in the style of the surrounding entries:

```markdown
### Fixed
- **Two `identity.reference` nodes onto the same entity no longer make every
  `@cardinality: one` relationship join the first one's FK column** (#368). The
  TypeScript codegen `relations()` block, the runtime relation traversal, the
  projection join lookup and the docs link graph each took the first
  target-matching reference, so a second association emitted a wrong-column join
  that compiled, typechecked, produced correct DDL and passed `meta verify` —
  surfacing only as wrong rows. Resolution is now explicit: unique candidate →
  `@sourceRefField` → name pairing → `ERR_INVALID_RELATIONSHIP` at load, in all
  four ports. `@sourceRefField` is now legal on `@cardinality: one` (it
  previously failed to load there). No vocabulary change; `metamodelVersion`
  unchanged.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md CLAUDE.md spec/decisions/ADR-0029-entity-child-extends-and-via-inference.md docs/features
git commit -m "docs: ADR-0029 Amendment 1 + changelog for #368"
```

---

## Task 11: End-to-end verification against the issue's repro

- [ ] **Step 1: Build the whole TS workspace**

```bash
cd server/typescript && bun run --filter '*' build && bun run --filter '*' typecheck
```
Expected: exit 0 (this is the same gate `.githooks/pre-push` runs)

- [ ] **Step 2: Reproduce the issue exactly**

Create a scratch project outside the repo, paste the `metaobjects/meta.json` and `metaobjects.config.ts` from issue #368 verbatim, then:

```bash
meta eject entity && meta gen
```

Expected in `src/generated/Match.ts`:

```ts
export const matchesRelations = relations(matches, ({ one }) => ({
  homeTeam: one(teams, { fields: [matches.homeTeamId], references: [teams.id] }),
  awayTeam: one(teams, { fields: [matches.awayTeamId], references: [teams.id] }),
}));
```

- [ ] **Step 3: Confirm the ambiguous model is now refused**

Rename `awayTeamRef`→`betaRef` and `awayTeamId`→`betaFk` in the scratch model so nothing pairs, then run `meta verify`.
Expected: `ERR_INVALID_RELATIONSHIP` naming `Match.awayTeam` and both candidates.

- [ ] **Step 4: Run the local CI gate**

```bash
cd <repo-root> && scripts/ci-local.sh --quick
```
Expected: PASS (this is what CLAUDE.md asks for before opening a PR)

- [ ] **Step 5: Open the PR**

```bash
npx -y gh-axi pr create \
  --title "fix: two identity.reference nodes onto one entity made every association join the first FK (#368)" \
  --body-file <path-to-pr-body> \
  --repo=metaobjectsdev/metaobjects
```

The body must state: the four surfaces fixed, the resolution ladder, that `expected-registry.json` and `metamodelVersion` are unchanged, and the Task 8 audit result.

---

## Self-Review

**Spec coverage:**
- Issue "Proposed fix" 1 (declarable) → Tasks 2, 3, 7 via `@sourceRefField`
- Issue "Proposed fix" 2 (name pairing) → Task 1 stage 3, fixtured in Task 9
- Issue "Proposed fix" 3 (fail loudly) → Task 3 rule (e), cross-port in Task 7
- Issue "Root cause" (`relation-resolver.ts:95-101`) → Task 4
- Issue "anti-pattern check for existing estates" → covered by rule (e) firing at load, so `meta verify` reports it without regenerating (Task 11 Step 3 proves it)
- Extra surfaces beyond the issue → Tasks 5, 6, 8

**Open decision for the maintainer:** `@sourceRefField`'s registered *description* still reads "names the source-side FK field on the junction". Updating it to cover the 1:N meaning changes `expected-registry.json`, which per `CLAUDE.md` forces all four registries to publish at the next release even though the attr set — and so `metamodelVersion` — is unchanged. This plan **leaves the description alone** and documents the widened meaning in ADR-0029 Amendment 1, `CLAUDE.md` and the feature docs instead. Task 9 Step 4 enforces that choice. Flip it only on an explicit ruling.

**Type consistency:** `resolveRelationshipReference(holder, relationshipName, targetEntity, sourceRefField?)` and `referenceCandidatesFor(holder, targetEntity)` are used with those exact signatures in Tasks 3, 4, 5 and 7. `findReferencesBetween(a, b): ReferenceLookup[]` is used with that signature in Task 6 only.
