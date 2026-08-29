# Requirements Ledger — Phase 1 Capability Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author MetaObjects' own L1–L3 requirements ledger — a pillar-anchored functional capability map plus an ISO/IEC 25010 architectural quality tree — as stock metadata under the strict registry, gated in CI.

**Architecture:** One hand-authored YAML file at `metaobjects/meta.requirements.yaml` declaring two sibling roots: a `requirement.functional` tree (L1 solution → L2 pillar → L3 service) and a levelled `requirement.architectural` quality tree. No new vocabulary, no custom attributes, no `@implementedBy`. A `scripts/check-requirements-ledger.ts` gate runs the shipped `meta verify` against it and pins the exact diagnostic set, so any change in what the product says about this ledger is visible.

**Tech Stack:** YAML metadata (ADR-0006 sigil-free authoring), the `@metaobjectsdev/cli` `meta verify` binary at `server/typescript/packages/cli/bin/meta.ts`, Bun for the gate script, `scripts/ci-local.sh` for wiring.

**Spec:** `docs/superpowers/specs/2026-08-29-metamodel-requirements-ledger-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

**Vocabulary — stock only.** Use only `requirement.functional`, `requirement.architectural`, their registered attributes (`level`, `status`, `statement`, `counterexample`, `disposition`, `trackedBy`, `supersededBy`, `implementedBy`), and the common doc attrs (`title`, `description`, `notes`, `summary`, `aliases`, `deprecated`, `replacedBy`, `seeAlso`). **No custom attributes. Strict enforcement stays on. Never pass `strict: false`.**

**`@implementedBy` is omitted on every node.** Its referent is a model node; this repository declares none. It is also an error above L4 (`ERR_REQUIREMENT_LINK_ABOVE_FLOOR`), and Phase 1 authors nothing below L3.

**Levels.** `1`–`5`. Nesting must strictly descend — a child's level must be greater than its parent's, or `ERR_REQUIREMENT_LEVEL_NESTING`. Skipping a level is legal; staying level or going back up is not. L1–L3 are levels of abstraction and ownership **in the problem domain, never code structure** — no per-port, per-package, per-deployable node at any of those tiers.

**Status.** Closed enum: `planned | live | partial | retired`. `retired` forbids `@implementedBy` (`ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS`) and is the only status on which `@supersededBy` is legal (`ERR_REQUIREMENT_SUPERSEDED_BY_NOT_RETIRED`). `@supersededBy` is RESOLVED, so it must name a requirement that exists in this ledger or it is `ERR_REQUIREMENT_DANGLING_REF`.

**Every node needs `statement` AND `counterexample`, at every level including L1.** Both are required by the loader. A `counterexample` must be a **static falsifiability test** — a concrete situation you could point at and say "that is the thing not happening". "Commerce does not work" is not one; "there is no way to buy anything" is.

**YAML house style** (`spec/yaml-house-style.md`, ADR-0006 D3):
- D3.1 — always the fused `type.subType` key: `requirement.functional:`, never `requirement:`.
- D3.2 — map body for every node, never scalar shorthand.
- D3.4 — **bare attribute keys**, no `@` sigil: `level: 4`, not `"@level": 4`. Reserved structural keys that stay bare in both forms: `name`, `package`, `extends`, `abstract`, `overlay`, `isArray`, `children`, `value`.
- D3.3 — quote any string value that could coerce to a bool, number or null.
- D3.5 — YAML list syntax for array-shaped attrs (`trackedBy`).

**Public repository hygiene.** This repo is PUBLIC. No other-project or client names — use "a downstream consumer", "an adopter". No absolute local paths (`/home/...`, `~/...`) in any committed file, including commit messages. Scan the staged diff before every commit.

**Git.** Commit to `main` directly; no side branches unless asked. **Stage explicitly — never `git add -A`.** End every commit message with:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NynrRND6ZUwGvq3ZUTCfxG
```

**The verify command**, used in every task:

```bash
bun server/typescript/packages/cli/bin/meta.ts verify --cwd .
```

Run it from the repository root. It exits 0 on warnings and non-zero on errors.

**Known and expected: `WARN_REQUIREMENT_NOTHING_IMPLEMENTS` on every `live` functional node.** The rule is `!architectural && live && !subtreeClaimsAnything(req)` (`requirement-check.ts:501`). Because this ledger omits `@implementedBy`, no functional subtree claims anything, so every live functional node warns. This is expected, is pinned by the Task 2 gate, and is recorded as a finding — do NOT try to silence it by adding `@implementedBy`, by using `planned`, or by muting the check.

---

## File Structure

| File | Responsibility |
|---|---|
| `metaobjects/meta.requirements.yaml` | **Create.** The entire ledger — both roots, all ~67 nodes. Single file: L1–L3 are problem-domain and cut across providers, so there is nothing to partition by yet. |
| `scripts/check-requirements-ledger.ts` | **Create.** The gate. Runs the shipped `meta verify` against the ledger and asserts the exact diagnostic set. |
| `scripts/test-requirements-ledger.ts` | **Create.** Self-test for the gate, matching the repo convention (`test-doc-examples.ts`, `test-publish-set.mjs`). Proves the gate FAILS when it should. |
| `scripts/ci-local.sh` | **Modify.** Add `gate_requirements_ledger` and one `step_if bun` line in the `gates` lane. |
| `spec/capability-ledger.md` | **Modify.** Three drift fixes (Task 1). |
| `server/typescript/packages/metadata/src/registry-manifest-exclusions.ts` | **Modify.** One stale comment (Task 1). |
| `docs/superpowers/specs/2026-08-29-metamodel-requirements-ledger-design.md` | **Modify.** Record the fifth drift finding (Task 9). |

---

## The complete node inventory

Task 3 onward author against this list. Names are `lowerCamelCase` identifiers; `title` carries the human-readable noun phrase.

**Functional tree — 39 nodes.**

```
L1  metaobjects
L2    declare              L3  typedFieldVocabulary  objectTaxonomy  attributeValueTypes
                               persistenceMapping    relationships   derivation
                               constraints           presentation    declaredPrompts
                               governanceVocabulary  inheritanceAndReferences
                               authoringFrontEnds                              (12)
L2    codegen              L3  entityAndSchema  dataAccess  apiSurface
                               webClient  ownershipAndRegeneration
                               documentationAndAgentContext                     (6)
L2    runtimeMetadata      L3  metadataDrivenCrud  typedQueryAndFilter
                               validationEnforcement  relationshipNavigation    (4)
L2    driftDetection       L3  schemaMigration  codegenDrift
                               promptAndTemplateDrift  liveDatabaseVerification (4)
L2    promptConstruction   L3  payloadProjection  deterministicRender
                               parserOnReceipt                                  (3)
L2    governTheStandard    L3  crossLanguageIdentity  vocabularyLifecycle
                               versioningAndRelease                             (3)
```

**Architectural tree — 26 nodes.**

```
L1  quality
L2    compatibility    L3  byteIdenticalRendering  wireContractStability
                           registryVocabularyParity                             (3)
L2    maintainability  L3  strictProvenance  ownAccessorDiscipline
                           namedMetamodelConstants                              (3)
L2    flexibility      L3  generatedCodeRunsStandalone  scaffoldAndOwn
                           providerExtension                                    (3)
L2    reliability      L3  failClosedLoading  reversibleMigrations              (2)
L2    security         L3  failClosedFilters  noCredentialSurface               (2)
L2    performance      L3  browserBundleBudget  promptCachePrefixStability      (2)
L2    interaction      L3  actionableLoaderErrors  agentContextAccuracy         (2)
```

**Retired entries — 2 nodes** (Task 9), which is what exercises `@status: retired` and `@supersededBy`:

```
L3  perPortMigrationEngines   under driftDetection, supersededBy metaobjects::schemaMigration
L3  osgiRuntimeVariant        under runtimeMetadata, no supersededBy
```

Total: **67 nodes**.

---

### Task 1: Fix the four drift defects

These come first because `spec/capability-ledger.md` is the document an author reads while authoring the ledger, and three of its statements are false. Authoring against a wrong document is how the wrong thing gets written.

**Files:**
- Modify: `spec/capability-ledger.md` (three edits)
- Modify: `server/typescript/packages/metadata/src/registry-manifest-exclusions.ts` (one comment)

**Interfaces:**
- Consumes: nothing.
- Produces: a `spec/capability-ledger.md` whose `@status` enum, attribute name and L2 definition agree with the shipped registry. Tasks 2–9 rely on it being correct.

- [ ] **Step 1: Confirm all four defects are still present**

```bash
cd <repo-root>
grep -n 'planned | live | partial' spec/capability-ledger.md
grep -n 'There is no member meaning' spec/capability-ledger.md
grep -n '`violation` are \*\*required at every level\*\*' spec/capability-ledger.md
grep -n 'an application, a library, a deployable' spec/capability-ledger.md
grep -n '11 generic `view.\*` controls' server/typescript/packages/metadata/src/registry-manifest-exclusions.ts
```

Expected: five hits. If any is missing, someone has already fixed it — verify against the registry before assuming the fix is correct, then skip that edit.

- [ ] **Step 2: Prove defect 1 against the registry**

```bash
node -e '
const m=require("./fixtures/registry-conformance/expected-registry.json");
for (const e of m.types) if (e.type==="requirement" && e.subType==="functional")
  for (const a of e.attrs||[]) if (a.name==="status") console.log(JSON.stringify(a.values));
'
```

Expected: `["planned","live","partial","retired"]` — four members, including `retired`.

- [ ] **Step 3: Fix defect 1 — the `retired` status**

In `spec/capability-ledger.md`, replace the body of the `### `status` is a closed enum` section. The current text reads:

```
`planned | live | partial`. An unknown value is a **hard error** — this is the one payload
with controlled evidence behind it, and leaving it an unchecked string would let a typo
silently disable it. There is no member meaning "retired": a requirement is prescriptive,
so a capability that no longer applies is DELETED.
```

Replace with:

```
`planned | live | partial | retired`. An unknown value is a **hard error** — this is the one
payload with controlled evidence behind it, and leaving it an unchecked string would let a
typo silently disable it.

`retired` is prescriptive, which is what makes it admissible: the entry states *"this must
not be rebuilt"* — a prohibition in force, falsifiable by one observable — rather than
journalling what happened. It was restored in `0.24.2` because it is the one claim the
controlled round did not refute: model-only agents flagged a deliberately-retired capability
**0 times out of 24**, every run proposing to extend it, against ledger arms catching it
**19 of 40**.

A retired entry **may not carry `@implementedBy`** (`ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS`,
a LOAD error in all five ports): a retired capability has no implementation by definition, so
the dangling-reference class is unreachable rather than tolerated. It may carry
`@supersededBy`, which is legal on `retired` only and RESOLVES like any other reference, so a
supersession chain stays walkable.
```

- [ ] **Step 4: Fix defect 2 — the renamed attribute**

In the `## Levels` section, find:

```
`level`, `status`, `statement` and `violation` are **required at every level**, L1 included —
```

Replace `violation` with `counterexample`:

```
`level`, `status`, `statement` and `counterexample` are **required at every level**, L1 included —
```

- [ ] **Step 5: Fix defect 3 — the L2 definition**

In the Levels table, the L2 row currently reads:

```
| **L2 Segment** | a major segmentation — an application, a library, a deployable | app / library | — |
```

Replace with:

```
| **L2 Segment** | a major segmentation of the problem domain — a capability area, never a module | domain area | — |
```

Then, immediately after the Levels table, add this paragraph:

```
**L1–L3 are problem-domain, and that is a contract rather than a preference.** `@level`'s
registered description — byte-gated in `expected-registry.json`, so every port carries it
verbatim — reads: *"L1-L3 are levels of abstraction and ownership in the problem domain, NOT
of code structure."* A directory, package, deployable or module is therefore not admissible at
any of those tiers. The mechanical test: if a behaviour-preserving refactor would force a node
to move, its level is wrong.
```

- [ ] **Step 6: Fix defect 4 — the stale count**

Count the excluded controls to confirm the number before writing it:

```bash
node -e '
const m=require("./spec/metamodel/view.json");
const c=(m.types||[]).filter(t=>t.subType!=="base"&&t.subType!=="currency").map(t=>t.subType);
console.log(c.length, c.join(" "));
'
```

Expected: `13` followed by the thirteen names. In `registry-manifest-exclusions.ts`, change both occurrences of `11 generic` to `13 generic` — one in the header comment block under `PRESENTATION_ONLY`, one in the doc comment above `classifyTypeSubType`.

- [ ] **Step 7: Verify the doc-examples gate still passes**

The edited document contains fenced metadata examples, and `gate_doc_examples` loads every one against the strict registry.

Run: `bun scripts/check-doc-examples.ts`
Expected: PASS. If it fails naming `spec/capability-ledger.md`, an example in the document uses vocabulary the loader has retired — fix the example, do not mute the gate.

- [ ] **Step 8: Verify the manifest is unchanged**

The comment edit must not alter emitted output.

Run: `cd server/typescript && bun test packages/metadata/test/registry-manifest.test.ts`
Expected: PASS, no snapshot change.

- [ ] **Step 9: Commit**

```bash
cd <repo-root>
git add spec/capability-ledger.md server/typescript/packages/metadata/src/registry-manifest-exclusions.ts
git commit -m "$(cat <<'MSG'
docs(spec): the capability ledger doc disagreed with the loader in three places

Found while specifying MetaObjects' own requirements ledger. Each is a
statement the document makes that the shipped registry contradicts, and an
author writing a ledger from this page would have written the wrong thing.

1. It gave @status as "planned | live | partial" and stated there is no member
   meaning retired. 0.24.2 restored `retired` as a fourth member and registered
   @supersededBy for it. The document denied the existence of a status the
   loader accepts and an attribute the registry gates.
2. It still called the attribute `violation` in the Levels prose — renamed
   @counterexample in 0.24.0 — while its own schema table said @counterexample.
3. It defined L2 as admitting "an application, a library, a deployable", while
   @level's byte-gated description forbids code structure at L1-L3. The registry
   is the contract; the doc now says so and gives the refactor test.

Also: registry-manifest-exclusions.ts said "the 11 generic view.* controls".
There are 13.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NynrRND6ZUwGvq3ZUTCfxG
MSG
)"
```

---

### Task 2: The ledger skeleton and its gate

Land the smallest ledger that loads and verifies, plus the gate that pins what `meta verify` says about it. Everything after this task is authoring against a working harness.

**Files:**
- Create: `metaobjects/meta.requirements.yaml`
- Create: `scripts/check-requirements-ledger.ts`
- Create: `scripts/test-requirements-ledger.ts`
- Modify: `scripts/ci-local.sh`

**Interfaces:**
- Consumes: Task 1's corrected `spec/capability-ledger.md`.
- Produces: `metaobjects/meta.requirements.yaml` with package `metaobjects` and two root nodes named `metaobjects` (functional, L1) and `quality` (architectural, L1). Tasks 3–9 add children to these two roots and change nothing else. `scripts/check-requirements-ledger.ts` exports nothing; it is a CLI entry point exiting 0 or 1.

- [ ] **Step 1: Write the failing gate script**

Create `scripts/check-requirements-ledger.ts`:

```ts
// Gate — MetaObjects' own requirements ledger loads, verifies, and says exactly
// what we expect it to say.
//
// WHY THIS PINS WARNINGS RATHER THAN JUST CHECKING THE EXIT CODE.
// `meta verify` exits 0 on warnings, so an exit-code-only gate would pass on a
// ledger that had quietly started emitting a hundred new ones. This ledger also
// emits a KNOWN warning by construction: it omits @implementedBy on every node
// (its subject is a solution, not a domain model, and this repo declares no
// object.entity at all), so WARN_REQUIREMENT_NOTHING_IMPLEMENTS fires on every
// live functional node — the rule is `!architectural && live &&
// !subtreeClaimsAnything(req)`. Pinning the SET of codes turns that from noise
// into a fact under test: a new code, or the known one disappearing, both fail.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** The one diagnostic code this ledger is expected to emit, and why. */
const EXPECTED_WARNING = "WARN_REQUIREMENT_NOTHING_IMPLEMENTS";

// Resolved against THIS FILE, not the working directory: the self-test runs the
// gate from a temp directory holding a throwaway ledger, so a cwd-relative path
// to the CLI would resolve to nothing there and every case would "fail" for the
// wrong reason.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(REPO_ROOT, "server/typescript/packages/cli/bin/meta.ts");

function main(): number {
  const run = spawnSync("bun", [CLI, "verify", "--cwd", "."], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;

  if (run.status !== 0) {
    console.error("requirements-ledger: `meta verify` exited non-zero.\n");
    console.error(output);
    return 1;
  }

  // Every diagnostic code the run mentioned, in first-seen order.
  const codes = [...output.matchAll(/\b(ERR_[A-Z0-9_]+|WARN_[A-Z0-9_]+)\b/g)].map((m) => m[1]);
  const errors = codes.filter((c) => c.startsWith("ERR_"));
  if (errors.length > 0) {
    console.error(`requirements-ledger: ${errors.length} error(s): ${[...new Set(errors)].join(", ")}\n`);
    console.error(output);
    return 1;
  }

  const unexpected = [...new Set(codes.filter((c) => c !== EXPECTED_WARNING))];
  if (unexpected.length > 0) {
    console.error(
      `requirements-ledger: unexpected diagnostic code(s): ${unexpected.join(", ")}.\n` +
      `Only ${EXPECTED_WARNING} is expected. If a new code is correct, decide deliberately\n` +
      `and add it here with a reason — do not widen this check to make a run pass.\n`,
    );
    console.error(output);
    return 1;
  }

  const summary = output.split("\n").find((l) => l.includes("meta verify — requirements:"));
  if (summary === undefined) {
    console.error("requirements-ledger: no requirements summary line — did the ledger load at all?\n");
    console.error(output);
    return 1;
  }

  console.log(`requirements-ledger: OK — ${summary.trim()}`);
  console.log(`requirements-ledger: ${codes.length} × ${EXPECTED_WARNING} (expected; @implementedBy is omitted by design)`);
  return 0;
}

process.exit(main());
```

- [ ] **Step 2: Run the gate to verify it fails**

Run: `bun scripts/check-requirements-ledger.ts`
Expected: FAIL — `no requirements summary line`, because `metaobjects/` does not exist yet.

- [ ] **Step 3: Create the ledger skeleton**

Create `metaobjects/meta.requirements.yaml`:

```yaml
# MetaObjects' own requirements ledger.
#
# This is stock metadata: `requirement.functional` and `requirement.architectural`
# as shipped, loaded by the same loader, under the same strict registry, as any
# adopter's. No custom attributes, no `strict: false`.
#
# `@implementedBy` is omitted on every node, deliberately. Its referent is a MODEL
# node and this repository declares no `object.entity` at all — the ledger's subject
# is the solution itself. Omitting it is legal (min=0) and dangle-free, and it is
# why `meta verify` reports WARN_REQUIREMENT_NOTHING_IMPLEMENTS on every live
# functional node. That warning is expected and pinned by
# scripts/check-requirements-ledger.ts. Do not silence it.
#
# Levels are PROBLEM-DOMAIN (`@level`'s byte-gated description: "L1-L3 are levels of
# abstraction and ownership in the problem domain, NOT of code structure"). No node
# at L1-L3 may name a package, port, module or deployable.
metadata.root:
  package: metaobjects
  children:
    - requirement.functional:
        name: metaobjects
        title: MetaObjects
        level: 1
        status: live
        statement: >-
          One typed declaration of a domain model drives code, runtime behaviour and
          drift checks across five languages, and what it generates keeps working with
          MetaObjects uninstalled.
        counterexample: >-
          A model that has to be restated by hand in each language, or generated code
          that stops compiling once the toolchain is removed.

    - requirement.architectural:
        name: quality
        title: Quality obligations
        level: 1
        status: live
        statement: >-
          MetaObjects meets stated, checkable quality obligations, organised by the
          ISO/IEC 25010:2023 product quality characteristics it actually bears.
        counterexample: >-
          A quality claim in a README that no gate, corpus or test can falsify.
```

- [ ] **Step 4: Run the gate to verify it passes**

Run: `bun scripts/check-requirements-ledger.ts`
Expected: PASS, printing a summary naming 2 entries (1 functional, 1 architectural) and 1 × `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`.

If it reports an unexpected code, read the code rather than widening the check — an `ERR_` here means the skeleton is malformed.

- [ ] **Step 5: Write the gate's self-test**

Create `scripts/test-requirements-ledger.ts`, following the repo convention that every gate proves it can fail:

```ts
// Self-test for scripts/check-requirements-ledger.ts.
//
// A gate nobody has seen fail is a gate nobody knows works. This drives the check
// against throwaway ledgers in a temp directory and asserts each one is caught.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = "scripts/check-requirements-ledger.ts";
const REPO = process.cwd();

/** Run the gate with `metaobjects/meta.requirements.yaml` set to `yaml`. */
function runAgainst(yaml: string): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "mo-ledger-"));
  try {
    mkdirSync(join(dir, "metaobjects"), { recursive: true });
    writeFileSync(join(dir, "metaobjects", "meta.requirements.yaml"), yaml);
    const run = spawnSync("bun", [join(REPO, CHECK)], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: run.status ?? 1, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID = `
metadata.root:
  package: metaobjects
  children:
    - requirement.functional:
        name: root
        level: 1
        status: live
        statement: "A thing is true."
        counterexample: "The thing is not true."
`;

/** Nesting that does not strictly descend — ERR_REQUIREMENT_LEVEL_NESTING. */
const BAD_NESTING = `
metadata.root:
  package: metaobjects
  children:
    - requirement.functional:
        name: root
        level: 2
        status: live
        statement: "A thing is true."
        counterexample: "The thing is not true."
        children:
          - requirement.functional:
              name: child
              level: 2
              status: live
              statement: "Another thing is true."
              counterexample: "It is not."
`;

/** @implementedBy above the L4 link floor — ERR_REQUIREMENT_LINK_ABOVE_FLOOR. */
const LINK_ABOVE_FLOOR = `
metadata.root:
  package: metaobjects
  children:
    - requirement.functional:
        name: root
        level: 1
        status: live
        statement: "A thing is true."
        counterexample: "The thing is not true."
        implementedBy: ["metaobjects::Nope"]
`;

let failures = 0;
function expect(label: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}\n${detail}`);
    failures++;
  }
}

console.log("test-requirements-ledger:");

const ok = runAgainst(VALID);
expect("a well-formed ledger passes", ok.status === 0, ok.output);

const nesting = runAgainst(BAD_NESTING);
expect("non-descending nesting is caught", nesting.status !== 0, nesting.output);

const floor = runAgainst(LINK_ABOVE_FLOOR);
expect("@implementedBy above the link floor is caught", floor.status !== 0, floor.output);

const missing = runAgainst("");
expect("an empty ledger is caught", missing.status !== 0, missing.output);

if (failures > 0) {
  console.error(`test-requirements-ledger: ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-requirements-ledger: all passed");
```

- [ ] **Step 6: Run the self-test**

Run: `bun scripts/test-requirements-ledger.ts`
Expected: four `ok` lines, then `all passed`.

If "a well-formed ledger passes" fails, the gate has a false positive — fix the gate, not the fixture.

- [ ] **Step 7: Wire the gate into CI**

In `scripts/ci-local.sh`, add the gate function immediately after `gate_doc_examples`:

```bash
# ── MetaObjects' own requirements ledger must load and verify ─────────────────
# The requirement feature ships in all five ports and this repository did not use
# it. The ledger is the dogfood, on the hardest available subject: this repo
# declares no object.entity at all, so a feature designed for domain models is
# exercised against a solution. The gate pins the diagnostic SET rather than the
# exit code, because `meta verify` exits 0 on warnings — and this ledger emits a
# known one by construction (@implementedBy is omitted, so no functional subtree
# claims anything). Offline; one YAML file.
gate_requirements_ledger() { bun scripts/check-requirements-ledger.ts && bun scripts/test-requirements-ledger.ts; }
```

Then add the step line in the `gates` lane, immediately after the `shipped doc examples load` line:

```bash
if want gates; then step_if bun "requirements ledger verifies"  gate_requirements_ledger;    fi
```

- [ ] **Step 8: Run the gates lane**

Run: `scripts/ci-local.sh --only gates`
Expected: all steps pass, including `requirements ledger verifies`.

- [ ] **Step 9: Commit**

```bash
git add metaobjects/meta.requirements.yaml scripts/check-requirements-ledger.ts scripts/test-requirements-ledger.ts scripts/ci-local.sh
git commit -m "$(cat <<'MSG'
feat(requirements): MetaObjects starts using its own requirement feature

The requirement vocabulary ships in all five ports and this repository has
never declared one. This lands the skeleton — two roots, a functional
capability map and an ISO 25010 quality tree — plus the gate that pins what
`meta verify` says about it.

The subject is deliberately the hardest one available: this repo declares no
object.entity at all, so a feature designed for domain models is exercised
against a solution. That is also why @implementedBy is omitted on every node —
its referent is a model node and there is none to name.

The gate pins the diagnostic SET, not the exit code. `meta verify` exits 0 on
warnings, so an exit-code gate would pass on a ledger that had quietly started
emitting a hundred. This ledger emits exactly one code by construction —
WARN_REQUIREMENT_NOTHING_IMPLEMENTS, because no functional subtree claims
anything — and pinning it turns that from noise into a fact under test.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NynrRND6ZUwGvq3ZUTCfxG
MSG
)"
```

---

### Task 3: The six functional L2 pillars

**Files:**
- Modify: `metaobjects/meta.requirements.yaml`

**Interfaces:**
- Consumes: the `metaobjects` L1 node from Task 2.
- Produces: six L2 nodes nested under `metaobjects` — `declare`, `codegen`, `runtimeMetadata`, `driftDetection`, `promptConstruction`, `governTheStandard`. Tasks 4–8 nest L3 children under these exact names.

The statements below are fixed by the spec — they are the design act, not authoring latitude. Paste them verbatim.

- [ ] **Step 1: Add a `children:` block to the L1 functional node**

Under the `metaobjects` node, after `counterexample:`, add:

```yaml
        children:
          - requirement.functional:
              name: declare
              title: Declare the model
              level: 2
              status: live
              statement: >-
                A domain model is expressed once, in typed metadata, with enough
                fidelity that every downstream artifact can be derived from it.
              counterexample: >-
                A model fact restated inside a generator, a migration or a
                hand-written type because the metadata cannot say it.

          - requirement.functional:
              name: codegen
              title: Codegen
              level: 2
              status: live
              statement: >-
                Every artifact derivable from the declaration is emitted as idiomatic
                per-language code the adopter owns and may hand-edit.
              counterexample: >-
                An adopter hand-writing a foreign key, a CRUD route or a validator
                chain the metadata already describes.

          - requirement.functional:
              name: runtimeMetadata
              title: Runtime metadata
              level: 2
              status: live
              statement: >-
                Metadata loaded at runtime drives behaviour with no generated code in
                the path.
              counterexample: >-
                A dynamic admin screen that needs a code change and a redeploy to show
                a newly declared field.

          - requirement.functional:
              name: driftDetection
              title: Drift detection
              level: 2
              status: live
              statement: >-
                Divergence between the declaration and what was built from it is
                detected before it reaches production.
              counterexample: >-
                A renamed field that silently degrades a prompt, or a column the
                database has and the model does not.

          - requirement.functional:
              name: promptConstruction
              title: Prompt construction
              level: 2
              status: live
              statement: >-
                A prompt is code: its payload is a typed projection, its text is
                external and provider-resolved, and its rendering is deterministic.
              counterexample: >-
                A whitespace change silently breaking an exact-prefix prompt-cache hit.

          - requirement.functional:
              name: governTheStandard
              title: Govern the standard
              level: 2
              status: live
              statement: >-
                The registered vocabulary is identical in every port, changes only
                deliberately, and records its retirements so they cannot be revived by
                accident.
              counterexample: >-
                One attribute meaning three different things in three ports while every
                gate reports green.
```

- [ ] **Step 2: Run the gate**

Run: `bun scripts/check-requirements-ledger.ts`
Expected: PASS — 8 entries (7 functional, 1 architectural), 7 × `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`.

If you see `ERR_REQUIREMENT_LEVEL_NESTING`, a child's `level` is not strictly greater than its parent's.

- [ ] **Step 3: Commit**

```bash
git add metaobjects/meta.requirements.yaml
git commit -m "$(cat <<'MSG'
feat(requirements): the six functional pillars at L2

L2 is the project's public four pillars plus the two they presuppose but never
name: Declare, which is what all four consume, and Govern the standard, which
is what keeps five ports identical. Every other candidate axis makes the
ledger's top tier disagree with CLAUDE.md, the docs and the website.

governTheStandard's counterexample is the @column incident stated as a
falsifiability test — one attribute meaning three different things in three
ports while every gate reports green. That is the entry this whole program
exists to make checkable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NynrRND6ZUwGvq3ZUTCfxG
MSG
)"
```

---

### Task 4: The twelve L3 capabilities under `declare`

**Files:**
- Modify: `metaobjects/meta.requirements.yaml`

**Interfaces:**
- Consumes: the `declare` L2 node from Task 3.
- Produces: twelve L3 nodes under `declare`, named exactly: `typedFieldVocabulary`, `objectTaxonomy`, `attributeValueTypes`, `persistenceMapping`, `relationships`, `derivation`, `constraints`, `presentation`, `declaredPrompts`, `governanceVocabulary`, `inheritanceAndReferences`, `authoringFrontEnds`. Phase 2 nests all 59 concrete subtypes under these as L4.

**Acceptance criteria for every statement you write in this task and Tasks 5–8:**

1. **The statement says what the capability IS, in one sentence, in the problem domain.** Not how it is built, not which package holds it.
2. **The counterexample is a static falsifiability test** — a concrete situation, not a negation of the statement. "Money is not stored correctly" fails; "a price column typed double, where 0.1 + 0.2 is not 0.3" passes.
3. **Neither mentions a package, port, module, class or file.** L1–L3 are problem-domain; if a behaviour-preserving refactor would force the wording to change, it is wrong.
4. **`description` is optional and used only for SCOPE** — what this node covers and which sibling owns the rest. A `description` that paraphrases the `statement` is padding; leave it off.
5. **`notes` is optional and carries what you had to look OUTSIDE the model to learn** — the incident, the release, the measurement. A sentence belongs in `notes` exactly when it would have to change because the implementation changed while the model did not.

Two worked examples, to be pasted as-is; the other ten follow their shape.

- [ ] **Step 1: Add the first two L3 nodes under `declare`**

```yaml
              children:
                - requirement.functional:
                    name: typedFieldVocabulary
                    title: Typed field vocabulary
                    level: 3
                    status: live
                    statement: >-
                      Every value a model can hold has a declared field type that fixes
                      its native type, its storage and its wire form together, so the
                      three cannot disagree.
                    counterexample: >-
                      A price stored as a floating-point number, where adding 0.1 and
                      0.2 does not give 0.3.
                    notes: >-
                      The behaviour-over-storage test is ADR-0037's: ask what a value
                      DOES, not whether it is a string. url and ip became field.uri and
                      field.inet because they carry native types and behaviour; email
                      and hostname stayed plain validated strings.

                - requirement.functional:
                    name: objectTaxonomy
                    title: The object taxonomy
                    level: 3
                    status: live
                    statement: >-
                      Every declared object is exactly one of three kinds — it owns its
                      data, it is a pure shape, or it is derived — and the kind decides
                      what the object is allowed to carry.
                    counterexample: >-
                      A shape meant only for transport that has acquired its own primary
                      key and a writable table.
                    description: >-
                      Covers which kinds exist and what each may hold. How a kind's data
                      is physically stored is persistenceMapping.
```

- [ ] **Step 2: Run the gate**

Run: `bun scripts/check-requirements-ledger.ts`
Expected: PASS — 10 entries, 9 × `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`.

- [ ] **Step 3: Author the remaining ten**

Add, in this order, as siblings in the same `children:` block. For each, write `statement` and `counterexample` meeting the five acceptance criteria above. The subject each must capture:

| name | title | what it must promise |
|---|---|---|
| `attributeValueTypes` | Attribute value types | every metadata attribute has a declared value type the loader checks, so a wrong-typed value fails the load rather than reaching a generator |
| `persistenceMapping` | Persistence mapping | a declaration says where its data lives and how its rows are identified, without naming a dialect |
| `relationships` | Relationships | a relationship between two objects is declared once and its foreign keys are derived from it, never restated |
| `derivation` | Derivation | a field whose value comes from elsewhere declares where from, and is read-only everywhere it appears |
| `constraints` | Constraints | validation rules are declared on the model and enforced identically wherever a value arrives |
| `presentation` | Presentation | how a value is shown is declared beside it without putting a UI framework into the metadata |
| `declaredPrompts` | Declared prompts | a prompt's payload is a declared typed projection, so payload growth appears as a diff |
| `governanceVocabulary` | Governance vocabulary | a capability the solution provides can itself be declared, levelled and checked like any other metadata |
| `inheritanceAndReferences` | Inheritance and references | a declaration can extend another and reference across packages unambiguously, independent of file load order |
| `authoringFrontEnds` | Authoring front-ends | metadata can be authored in a sigil-free front-end and lowered to the canonical interchange form deterministically |

`governanceVocabulary` is the self-referential entry — the requirement feature describing itself. Its counterexample should be the thing this whole program replaces: a capability list somewhere no build reads.

- [ ] **Step 4: Run the gate**

Run: `bun scripts/check-requirements-ledger.ts`
Expected: PASS — 20 entries (19 functional, 1 architectural), 19 × `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`.

- [ ] **Step 5: Review every statement against the acceptance criteria**

Read the twelve back. For each, answer out loud: is the counterexample a situation you could point at, or is it just the statement with "not" in it? Rewrite any that fail. This is the step the whole exercise exists for — a ledger of restated statements is the failure mode FR-038 retired half the vocabulary to prevent.

- [ ] **Step 6: Commit**

```bash
git add metaobjects/meta.requirements.yaml
git commit -m "$(cat <<'MSG'
feat(requirements): the twelve declaring capabilities at L3

All 59 concrete subtypes will hang under these as L4 in Phase 2. The placement
is deliberate: "a field.currency stores integer minor units" is a DECLARING
capability that codegen merely consumes, not a codegen one.

governanceVocabulary is the self-referential entry — the requirement feature
describing itself, in the ledger it is being used to author.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NynrRND6ZUwGvq3ZUTCfxG
MSG
)"
```

---

### Task 5: The L3 capabilities under `codegen` and `runtimeMetadata`

**Files:**
- Modify: `metaobjects/meta.requirements.yaml`

**Interfaces:**
- Consumes: the `codegen` and `runtimeMetadata` L2 nodes from Task 3.
- Produces: six L3 nodes under `codegen` and four under `runtimeMetadata`, named exactly as in the inventory.

- [ ] **Step 1: Author the six under `codegen`**

Same five acceptance criteria as Task 4. Subjects:

| name | title | what it must promise |
|---|---|---|
| `entityAndSchema` | Entity and schema artifacts | the types and table definitions an adopter would otherwise hand-write are emitted from the declaration |
| `dataAccess` | Data access | typed reads and writes for a declared object are generated, not hand-rolled |
| `apiSurface` | API surface | the request and response contract for a declared object is generated, and the same contract holds wherever it is served |
| `webClient` | Web client artifacts | forms, grids and typed fetch hooks are generated from the same declaration that generated the server |
| `ownershipAndRegeneration` | Ownership and regeneration | a hand edit inside generated output survives regeneration, and the adopter owns the generator |
| `documentationAndAgentContext` | Documentation and agent context | the documentation and the agent-facing context an adopter reads are generated from the model, so they cannot describe a model that no longer exists |

`ownershipAndRegeneration` should carry a `notes` recording that the merge base is `.gen-state/.hashes.json` and that it is committed — without it a fresh clone cannot tell a file it wrote from one somebody edited.

- [ ] **Step 2: Author the four under `runtimeMetadata`**

| name | title | what it must promise |
|---|---|---|
| `metadataDrivenCrud` | Metadata-driven CRUD | create, read, update and delete work against a declared object with no generated code in the path |
| `typedQueryAndFilter` | Typed query and filter | a caller filters and sorts by declared fields only, and an undeclared or disallowed one is refused rather than ignored |
| `validationEnforcement` | Validation enforcement | declared constraints are enforced at the point a value arrives, not merely described |
| `relationshipNavigation` | Relationship navigation | a declared relationship can be traversed at runtime without hand-written join code |

`typedQueryAndFilter`'s counterexample should be the fail-open failure: a filter naming a field nobody declared, quietly returning every row.

- [ ] **Step 3: Run the gate**

Run: `bun scripts/check-requirements-ledger.ts`
Expected: PASS — 30 entries (29 functional, 1 architectural), 29 × `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`.

- [ ] **Step 4: Review against the acceptance criteria, then commit**

```bash
git add metaobjects/meta.requirements.yaml
git commit -m "$(cat <<'MSG'
feat(requirements): the codegen and runtime capabilities at L3

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NynrRND6ZUwGvq3ZUTCfxG
MSG
)"
```

---

### Task 6: The L3 capabilities under `driftDetection`, `promptConstruction` and `governTheStandard`

**Files:**
- Modify: `metaobjects/meta.requirements.yaml`

**Interfaces:**
- Consumes: those three L2 nodes from Task 3.
- Produces: four L3 nodes under `driftDetection`, three under `promptConstruction`, three under `governTheStandard`. `schemaMigration` is referenced by Task 9's `@supersededBy`, so its name must be exactly `schemaMigration`.

- [ ] **Step 1: Author the four under `driftDetection`**

| name | title | what it must promise |
|---|---|---|
| `schemaMigration` | Schema migration | the difference between a declaration and a live database is computed and emitted as a reversible migration |
| `codegenDrift` | Codegen drift | generated output that no longer matches the declaration is reported before it is deployed |
| `promptAndTemplateDrift` | Prompt and template drift | a prompt referring to a field the model no longer has is caught at build time |
| `liveDatabaseVerification` | Live database verification | a database can be checked against the declaration without running a migration against it |

- [ ] **Step 2: Author the three under `promptConstruction`**

| name | title | what it must promise |
|---|---|---|
| `payloadProjection` | Payload projection | what a prompt sends is a declared typed projection, authoritative over anything derivable, so growth is a diff |
| `deterministicRender` | Deterministic render | the same payload renders byte-identically every time and everywhere |
| `parserOnReceipt` | Parser on receipt | a declared response shape is parsed and validated on arrival rather than trusted |

`deterministicRender`'s counterexample should name the cache consequence, since that is what makes it falsifiable: two runs over one payload producing different bytes, so an exact-prefix cache hit is lost.

- [ ] **Step 3: Author the three under `governTheStandard`**

| name | title | what it must promise |
|---|---|---|
| `crossLanguageIdentity` | Cross-language identity | the same declaration means the same thing in every language, and a divergence fails a gate rather than reaching an adopter |
| `vocabularyLifecycle` | Vocabulary lifecycle | vocabulary enters deliberately and leaves recorded, with a mechanical path from the old form to the new |
| `versioningAndRelease` | Versioning and release | the metadata contract and the software contract carry separate version numbers, and a change to either moves its own |

`crossLanguageIdentity` should carry a `notes` recording the `@column` measurement — three meanings across the ports on one attribute, every port byte-matching the manifest throughout — because that is the evidence the statement exists for.

- [ ] **Step 4: Run the gate**

Run: `bun scripts/check-requirements-ledger.ts`
Expected: PASS — 40 entries (39 functional, 1 architectural), 39 × `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`.

The functional tree is now complete at 39 nodes.

- [ ] **Step 5: Review against the acceptance criteria, then commit**

```bash
git add metaobjects/meta.requirements.yaml
git commit -m "$(cat <<'MSG'
feat(requirements): the drift, prompt and governance capabilities at L3

Completes the functional tree at 39 nodes. crossLanguageIdentity carries the
@column measurement in notes — three meanings across the ports on one
attribute, every port byte-matching the manifest throughout — because that is
the evidence its statement exists for.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NynrRND6ZUwGvq3ZUTCfxG
MSG
)"
```

---

### Task 7: The seven ISO 25010 quality characteristics at L2

**Files:**
- Modify: `metaobjects/meta.requirements.yaml`

**Interfaces:**
- Consumes: the `quality` L1 architectural node from Task 2.
- Produces: seven L2 `requirement.architectural` nodes under `quality`, named `compatibility`, `maintainability`, `flexibility`, `reliability`, `security`, `performance`, `interaction`.

Two of ISO/IEC 25010:2023's nine characteristics are deliberately absent: *functional suitability*, because the functional tree above is it, and *safety*, because nothing in scope can cause physical harm. Record that in the L1 node's `notes` so the omission reads as a decision rather than an oversight.

- [ ] **Step 1: Add `notes` to the `quality` L1 node**

```yaml
        notes: >-
          Organised by ISO/IEC 25010:2023's product quality characteristics. Two of
          the nine are deliberately absent: functional suitability, because the
          functional capability map is that characteristic in full; and safety,
          because nothing in scope can cause physical harm. The tree shape follows
          the arc42 / ATAM quality tree, whose leaves are concrete falsifiable
          scenarios — which is what statement plus counterexample already is.
```

- [ ] **Step 2: Add the seven L2 characteristics**

Architectural nodes at L1–L3 are exempt from `ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS` via `mayReferenceModel()`, so they need no `@implementedBy` and must not carry one.

```yaml
        children:
          - requirement.architectural:
              name: compatibility
              title: Compatibility
              level: 2
              status: live
              statement: >-
                One declaration produces the same meaning in every language port and on
                every wire, so a consumer can change ports without changing behaviour.
              counterexample: >-
                One attribute meaning three different things in three ports while every
                gate reports green.
              notes: >-
                The dominant characteristic for this project and the one the entire
                conformance apparatus exists to defend. Author its children first.
```

Then six more in the same shape. Subjects:

| name | title | what it must promise |
|---|---|---|
| `maintainability` | Maintainability | the vocabulary and the code reading it can be changed safely, because every element is declared, named and reachable by one route |
| `flexibility` | Flexibility | an adopter can take what MetaObjects produced and keep working without it |
| `reliability` | Reliability | when something is wrong the system refuses rather than proceeding, and every destructive step has a way back |
| `security` | Security | an input that was never declared cannot widen what a caller can reach |
| `performance` | Performance efficiency | the cost of using MetaObjects at runtime is bounded and does not grow with the size of the model |
| `interaction` | Interaction capability | a person or an agent that gets something wrong is told what is wrong and what to do about it |

- [ ] **Step 3: Run the gate**

Run: `bun scripts/check-requirements-ledger.ts`
Expected: PASS — 47 entries (39 functional, 8 architectural), still 39 × `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`.

**The warning count must NOT rise.** Architectural nodes do not emit it. If it rises, a node was authored as `requirement.functional` by mistake.

If you see `ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS`, a node is at L4 or above the link floor rather than L2 — check its `level`.

- [ ] **Step 4: Commit**

```bash
git add metaobjects/meta.requirements.yaml
git commit -m "$(cat <<'MSG'
feat(requirements): the ISO 25010 quality characteristics at L2

Follows spec/capability-ledger.md's own guidance for levelled architectural
requirements — an ISO/IEC 25010 characteristic at the top, refined downward —
and matches the arc42 / ATAM quality tree, whose leaves are concrete
falsifiable scenarios. statement plus counterexample already is that leaf.

Seven of nine characteristics carry real policies here. Functional suitability
is absent because the functional tree is that characteristic in full; safety
because nothing in scope can cause physical harm. Both omissions are recorded
on the root rather than left to be inferred.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NynrRND6ZUwGvq3ZUTCfxG
MSG
)"
```

---

### Task 8: The eighteen quality claims at L3

**Files:**
- Modify: `metaobjects/meta.requirements.yaml`

**Interfaces:**
- Consumes: the seven L2 characteristics from Task 7.
- Produces: eighteen L3 architectural nodes, named exactly as in the inventory. This completes the architectural tree; nothing goes below L3.

An architectural L3 must be **universally quantified** — "every X does Y" — because its check is universality, not existence. A statement about one place belongs in the functional tree.

- [ ] **Step 1: Author the three under `compatibility`**

| name | title | what it must promise |
|---|---|---|
| `byteIdenticalRendering` | Byte-identical rendering | every port renders the same declared template and payload to the same bytes |
| `wireContractStability` | Wire contract stability | every value crosses the wire in one agreed form regardless of which port serialised it |
| `registryVocabularyParity` | Registry vocabulary parity | every port registers exactly the same vocabulary, proven by matching one manifest rather than by inspection |

- [ ] **Step 2: Author the remaining fifteen**

| parent | name | title | what it must promise |
|---|---|---|---|
| `maintainability` | `strictProvenance` | Strict provenance | every accepted attribute comes from a declared provider, so an invented one fails the load rather than reaching a generator |
| `maintainability` | `ownAccessorDiscipline` | Effective-value access | every read of an element's effective value resolves inheritance, so nothing declared on a parent is silently dropped |
| `maintainability` | `namedMetamodelConstants` | Named vocabulary constants | every reference to vocabulary in code goes through a named constant, so a typo fails to compile |
| `flexibility` | `generatedCodeRunsStandalone` | Generated code stands alone | every generated artifact compiles and runs with MetaObjects uninstalled |
| `flexibility` | `scaffoldAndOwn` | Scaffold and own | every generator an adopter depends on can be copied into their repository and modified |
| `flexibility` | `providerExtension` | Provider extension | an adopter can add vocabulary through a declared provider without forking anything |
| `reliability` | `failClosedLoading` | Fail-closed loading | every ambiguous or unresolvable declaration is refused at load rather than resolved by guess |
| `reliability` | `reversibleMigrations` | Reversible migrations | every emitted migration has a counterpart that undoes it |
| `security` | `failClosedFilters` | Fail-closed filters | every filter and sort a caller supplies is checked against a declared allowlist, and anything else is refused |
| `security` | `noCredentialSurface` | No credential surface | nothing MetaObjects generates or stores accepts, holds or transmits a credential |
| `performance` | `browserBundleBudget` | Browser bundle budget | nothing a browser bundle pulls in requires server-only code to be reachable from it |
| `performance` | `promptCachePrefixStability` | Prompt cache prefix stability | every render of an unchanged prompt produces an unchanged prefix |
| `interaction` | `actionableLoaderErrors` | Actionable errors | every refusal names what was wrong, where, and what would fix it |
| `interaction` | `agentContextAccuracy` | Agent context accuracy | every piece of agent-facing context ships vocabulary the loader currently accepts |

`agentContextAccuracy` should carry a `notes` recording why it is a requirement rather than a nicety: three separate times a shipped doc or skill taught vocabulary the loader had already retired, and an adopter found it every time.

- [ ] **Step 3: Run the gate**

Run: `bun scripts/check-requirements-ledger.ts`
Expected: PASS — 65 entries (39 functional, 26 architectural), still 39 × `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`.

- [ ] **Step 4: Verify every architectural statement is universally quantified**

Read the eighteen back. Any statement that describes one place rather than every place belongs in the functional tree — move it or rewrite it.

- [ ] **Step 5: Commit**

```bash
git add metaobjects/meta.requirements.yaml
git commit -m "$(cat <<'MSG'
feat(requirements): the eighteen quality claims at L3

Completes the architectural tree at 26 nodes. Each is universally quantified —
"every X does Y" — because an architectural requirement's check is
universality, not existence; a claim about one place belongs in the functional
tree.

The tree stops at L3 deliberately. L4 and L5 would need @implementedBy against
model nodes, and this repository declares none.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NynrRND6ZUwGvq3ZUTCfxG
MSG
)"
```

---

### Task 9: Retired capabilities, dispositions, and the fifth finding

The ledger so far is all `live`. This task exercises the parts of the vocabulary that only a real ledger reaches: `retired` with `@supersededBy`, and `@disposition` with `@trackedBy` on genuine open work.

**Files:**
- Modify: `metaobjects/meta.requirements.yaml`
- Modify: `docs/superpowers/specs/2026-08-29-metamodel-requirements-ledger-design.md`

**Interfaces:**
- Consumes: `schemaMigration` (Task 6) as the `@supersededBy` target, and `runtimeMetadata` (Task 3) as a parent.
- Produces: the completed Phase 1 ledger at 67 nodes.

- [ ] **Step 1: Add the retired migration-engine entry under `driftDetection`**

`@supersededBy` is RESOLVED, so the target must exist in this ledger. A bare name binds package-locally (ADR-0042); both nodes are in package `metaobjects`, so the fully-qualified form is `metaobjects::schemaMigration`.

```yaml
                - requirement.functional:
                    name: perPortMigrationEngines
                    title: Per-port migration engines
                    level: 3
                    status: retired
                    statement: >-
                      Each language port computes and applies its own schema
                      migrations from the declaration.
                    counterexample: >-
                      Two ports emitting different migrations for one declaration, so
                      the database that results depends on who ran the tool.
                    supersededBy: metaobjects::schemaMigration
                    notes: >-
                      Retired under ADR-0015: schema migration is owned by one shared
                      engine. The per-port engines were removed, and with them the
                      dev/test auto-create path, so runtime data access is now pure
                      data access. Do not reintroduce a second migration engine in any
                      port — the counterexample above is what it produces.
```

- [ ] **Step 2: Verify `@supersededBy` resolves**

Run: `bun scripts/check-requirements-ledger.ts`
Expected: PASS — 66 entries.

If you see `ERR_REQUIREMENT_DANGLING_REF`, the target name is wrong. If you see `ERR_REQUIREMENT_SUPERSEDED_BY_NOT_RETIRED`, the status is not `retired`. If you see `ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS`, an `implementedBy` crept in — a retired entry may not carry one.

**The warning count must stay at 39.** A `retired` node is not `live`, so it emits no `WARN_REQUIREMENT_NOTHING_IMPLEMENTS` — adding one adds an entry without adding a warning. If the count rises to 40, the new node's status is not `retired`.

- [ ] **Step 3: Add the retired OSGi entry under `runtimeMetadata`**

This one carries no `@supersededBy` — nothing replaced it, and inventing a target to fill the slot would be exactly the dishonesty the attribute exists to prevent.

```yaml
                - requirement.functional:
                    name: osgiRuntimeVariant
                    title: OSGi runtime variant
                    level: 3
                    status: retired
                    statement: >-
                      Runtime metadata is consumable from inside a dynamic module
                      container that can load and unload providers at runtime.
                    counterexample: >-
                      A metadata registry whose contents depend on which modules
                      happen to be started.
                    notes: >-
                      Retired under ADR-0012. Nothing replaced it, which is why this
                      entry carries no supersededBy: the requirement was withdrawn
                      rather than re-homed. A registry whose vocabulary depends on
                      load order is the opposite of the sealed, deliberately-agreed
                      registry ADR-0023 later made the default.
```

- [ ] **Step 4: Add `@disposition` and `@trackedBy` where work is genuinely outstanding**

At least one L3 node has a known, decided gap. `declaredPrompts` is the clearest: the library-side building blocks ship in all five ports, and MCP exposure of declared prompts does not. Change its status and add the decision:

```yaml
                    status: partial
                    disposition: deferred
                    trackedBy: ["metaobjectsdev/metaobjects#10"]
```

`deferred` without a `@trackedBy` emits `WARN_REQUIREMENT_DEFERRED_UNTRACKED`, which the gate will reject as an unexpected code — that is the check working. Verify the issue reference is real before writing it:

```bash
gh issue view 10 --repo metaobjectsdev/metaobjects --json number,title,state 2>&1 | head -5
```

If the issue does not exist or is closed, use `accepted` instead of `deferred` — `accepted` needs no ticket — or find the correct issue number. Do not invent one.

- [ ] **Step 5: Run the full gates lane**

Run: `scripts/ci-local.sh --only gates`
Expected: every step passes, including `requirements ledger verifies`.

- [ ] **Step 6: Record the fifth drift finding in the spec**

In `docs/superpowers/specs/2026-08-29-metamodel-requirements-ledger-design.md`, in the `## Drift found while specifying this, and fixed by it` section, add a fifth entry. Note this one is **reported, not fixed** — it is a product behaviour change affecting every adopter, not a defect in this program's own work:

```
5. **`WARN_REQUIREMENT_NOTHING_IMPLEMENTS` has no organisational-tier exemption,
   where its architectural twin does.** The functional rule is
   `!architectural && live && !subtreeClaimsAnything(req)`; the architectural one
   additionally tests `req.mayReferenceModel()`, which is false for L1-L3 of a
   levelled tree. So an architectural organisational tier is exempt and a functional
   one is not, although the functional guard's own comment makes the identical
   argument: *"an organisational tier legitimately implements nothing ITSELF - it
   delegates to children, and that is the whole shape of the tree."*

   For a ledger whose subject is a solution rather than a domain model, no subtree
   can ever claim anything, so every live functional node warns permanently. This
   ledger emits 39 such warnings and will emit more in Phase 2. They are pinned by
   `scripts/check-requirements-ledger.ts` rather than silenced.

   **Reported, not fixed here.** The rule is correct for the adopter case it was
   written for - a functional subtree claiming nothing usually IS a capability
   nobody built - so changing it is a product decision affecting every adopter,
   not a defect in this program. The candidate fix is to apply the same
   `mayReferenceModel()` predicate on both sides.
```

- [ ] **Step 7: Commit**

```bash
git add metaobjects/meta.requirements.yaml docs/superpowers/specs/2026-08-29-metamodel-requirements-ledger-design.md
git commit -m "$(cat <<'MSG'
feat(requirements): retired capabilities, dispositions, and a fifth finding

Completes Phase 1 at 67 nodes. Two retired entries give @status: retired and
@supersededBy their first real use outside a four-node conformance fixture: the
per-port migration engines (ADR-0015), superseded by the single shared engine,
and the OSGi runtime variant (ADR-0012), which carries no supersededBy because
nothing replaced it — inventing a target to fill the slot is exactly the
dishonesty the attribute exists to prevent.

The fifth drift finding is REPORTED rather than fixed:
WARN_REQUIREMENT_NOTHING_IMPLEMENTS has no organisational-tier exemption where
its architectural twin does, so a ledger whose subject is a solution rather
than a domain model warns on every live functional node, permanently. The rule
is correct for the adopter case it was written for, so changing it is a product
decision rather than a defect in this program. The 39 warnings are pinned by
the gate rather than silenced.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NynrRND6ZUwGvq3ZUTCfxG
MSG
)"
```

---

## Done when

- `metaobjects/meta.requirements.yaml` holds 67 nodes: 39 functional (37 live, 2 retired) and 26 architectural, plus one `partial` with a recorded disposition.
- `bun scripts/check-requirements-ledger.ts` passes, reporting zero errors and exactly `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`.
- `bun scripts/test-requirements-ledger.ts` passes all four cases.
- `scripts/ci-local.sh --only gates` passes.
- `spec/capability-ledger.md` agrees with the shipped registry on the status enum, the attribute name and the L2 definition.
- The spec's drift section carries five findings, the fifth marked reported-not-fixed.

## Not in this plan

Phase 2 onward, per the spec: L4 subtype requirements, L5 attribute requirements, the derived-path link from a requirement to `spec/metamodel/*.json`, the repo-local verify, and any code generation. Also excluded: any new metamodel vocabulary, so `metamodelVersion` does not move and `expected-registry.json` is untouched.
