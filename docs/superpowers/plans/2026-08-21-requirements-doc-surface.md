# The `requirements` docs surface — implementation plan

Design: [`2026-08-21-requirements-doc-surface-design.md`](../specs/2026-08-21-requirements-doc-surface-design.md).

**Slice scope:** the surface only — the requirement walk, both renderers, the generator, shape
C's backlink, and the surface wiring. Additive. **Must not change `meta docs` output for any
model that declares no `requirement.*` node.**

## Global constraints

1. **Metadata alone.** `meta docs` guarantees output *"from metadata **ALONE** — no gen config,
   no codegen pipeline"* ([`docs.ts:1-12`](../../../server/typescript/packages/cli/src/commands/docs.ts)).
   This surface adds **no** new input. No filesystem walk, no test-source scan, no config read.
   That sentence is what rules out the retired `@verifiedBy` scan (design §3) and it must keep
   being true.
2. **No test link, under any input.** Design §3. There is no join key; do not invent one.
3. **Resolving accessors only.** ADR-0039 — a requirement's `@statement`, `@level`, `@status`
   and `@implementedBy` must be read through the resolving accessors on `MetaRequirement`
   (`level()`, `status()`, `implementedBy()`, `trackedBy()`, `disposition()`), never `own*()`.
   A requirement that `extends` an abstract parent must inherit.
4. **`notes` is never emitted.** [`documentation.json:39`](../../../spec/metamodel/documentation.json) —
   internal-only. `description` is emitted.
5. **Constants, not literals.** `"requirements"` (the surface), the two filenames, and every
   metamodel string come from named constants.

## Task 1 — project the docs row from the EXISTING walk

**Do not write a new walk.**
[`codegen-ts/src/requirement-walk.ts`](../../../server/typescript/packages/codegen-ts/src/requirement-walk.ts)
already does the depth-first walk of every `requirement.*` node — nested ones included — and
already produces the dotted `path` (hierarchy is nesting), `subType`, `level`, `status`, and
resolved `@implementedBy` targets as `ResolvedClaim[]`. It is what `requirementTests()` is
built on, so reusing it keeps the docs surface and the stub generator agreeing on what the
ledger contains **by construction** rather than by two walks that must be kept in step.

**New:** `codegen-ts/src/generators/requirements-view.ts` — a projection over
`walkRequirements(root)` adding only what the docs surface needs and `RequirementView` lacks:

```ts
export interface RequirementRow {
  readonly path: string;          // dotted child-name path, e.g. "checkout.payment.capture"
  readonly depth: number;         // 0 for a root-level node
  readonly subType: string;       // "functional" | "architectural"
  readonly level: number | undefined;
  readonly status: string | undefined;
  readonly disposition: string | undefined;
  readonly trackedBy: readonly string[];
  readonly statement: string | undefined;
  readonly violation: string | undefined;
  readonly description: string | undefined;   // NEVER notes
  readonly implementedBy: readonly string[];
}
export function requirementRows(root: MetaData): RequirementRow[];
```

Depth-first, declaration order. `path` is the dotted child-name path, matching how every other
node in the model is addressed.

**Tests first:**
- a flat ledger projects one row per node, in declaration order
- **a nested ledger projects parent AND children, with correct `depth` and dotted `path`** — a
  flat fixture cannot tell a depth-first walk from a top-level-only one, which is the specific
  way this walk fails silently
- a requirement that `extends` an abstract parent inherits `@level`/`@status` (ADR-0039 —
  assert against a fixture where the child declares neither)
- `notes` is absent from `RequirementRow` at the type level and from every projected value
- a root with zero requirement nodes returns `[]`

## Task 2 — the markdown renderer

**New:** `codegen-ts/src/generators/requirements-markdown.ts`, `renderRequirementsMarkdown(rows)`.

Nesting rendered as heading depth; each row carries statement, violation, level, status,
disposition, trackedBy and resolved `@implementedBy` targets. `description` emitted where
present.

**Tests first:** a golden over a nested fixture; `notes` absent; an empty row list renders
nothing (not an empty document — Task 6 depends on this).

## Task 3 — the TOON renderer

**New:** `codegen-ts/src/generators/requirements-toon.ts`, `renderRequirementsToon(rows)`.

Reuses `toonEncode` from the CLI's existing `lib/format.ts` convention and the already-present
`@toon-format/toon` dependency — **no new dependency**. The header must declare the row count:
`requirements[N]{path,level,status,claims,statement}:`.

**Tests first:**
- **the declared header count equals the number of rows emitted, on a NESTED fixture** — the
  gate that makes the artifact self-checking, and the reason TOON was chosen at all (design §5)
- prose containing a comma round-trips (TOON quotes comma-bearing strings; assert rather than
  assume)
- empty row list emits nothing

## Task 4 — the `requirementsFile()` generator

**New:** `codegen-ts/src/generators/requirements-file.ts`.

`oncePerRun`, emitting `requirements.md` + `requirements.toon`. Both unconditionally when the
ledger is non-empty; **neither when it is empty** (design §6 rule 2). Registered in
`generator-registry.ts` and exported from `generators/index.ts`.

**Tests first:** both files emitted for a ledger; **zero files for an empty ledger**; emission
is independent of any config being loadable.

## Task 5 — shape C, the backlink on entity pages

Extend `docs-file.ts` so an entity page names the requirements claiming it, resolved from the
Task 1 rows by `@implementedBy`.

**Tests first:**
- a claimed entity's page gains the backlink
- **an unclaimed entity's page is byte-identical to today's** — the no-churn pin
- an entity claimed by several requirements lists all of them
- entity-grain only: a claimed `object.value` / `object.projection` gains nothing
  ([`capability-ledger.md:285-296`](../../../spec/capability-ledger.md) — coverage is
  entity-grain)

## Task 6 — surface wiring

- `DocsSurface` gains `"requirements"`
  ([`metaobjects-config.ts:195`](../../../server/typescript/packages/codegen-ts/src/metaobjects-config.ts)).
- `resolveDocsConfig`'s default becomes `["model", "api", "requirements"]`. Safe **only**
  because Task 4 emits nothing for an empty ledger — do not land this before Task 4 is green.
- `docs.ts` gains a `--requirements` flag narrowing markdown surfaces exactly as
  `--model` / `--api` do, and a dispatch branch. `--site` / `--metamodel` are untouched (not
  surfaces).

**Tests first:** `--requirements` alone emits only this surface; no flag emits all three; a
project with no ledger sees byte-identical output to before this plan.

## Task 7 — the conformance fixture

A `codegen-conformance` case whose model carries a nested `requirement.*` tree, gating both
artifacts byte-for-byte — the mechanism that keeps the markdown and the TOON in agreement.

**The fixture must carry, or the gate is blind:**
- **nesting** (Tasks 1 + 3 both fail silently on a flat corpus)
- a requirement declaring **both `description` and `notes`** — with only one of them, a test
  cannot tell suppression from absence
- a requirement whose `name` **exactly matches a real test file in this repo** — the case that
  would regress design §3 silently if anyone reintroduces a scan
- an entity claimed by several requirements, and one claimed by none
- a child requirement inheriting `@level`/`@status` through `extends`

**Prove the gate can fail:** sabotage the fixture and watch the lane go red. A gate never
demonstrated failing is decorative — this repo has been bitten precisely here, where a golden
went quiet the moment it was regenerated to match a bad fix.

## Deferred — explicitly NOT this slice

- **The structural test link** (design §7). `requirementTests()` already ships, and its default
  stub path is metadata-derivable — so the blocker is *not* computing the path. It is that
  **whether a stub exists** depends on the project having wired the generator, which is a
  gen-config fact this command cannot see. Emitting a path for a project that never wired it
  would assert a file that does not exist — the scan's false-assurance failure, relocated. So
  the link lands as config-gated enrichment on the `api`-surface precedent
  ([`docs.ts:412`](../../../server/typescript/packages/cli/src/commands/docs.ts)), in its own
  slice.
- **The spec-citation slot** (design §8) — a metamodel question for ADR-0037, not a docs one.
- **Non-TS ports.** `meta docs` is Node-CLI-owned.
- **`docs.layout` interaction** for the index page (design §11).

## Self-review

- Every task's tests are named before its implementation, per this repo's TDD discipline.
- The two ways this feature fails *silently* — dropping rows from a nested walk, and emitting
  `notes` — each get a fixture shaped so the failure cannot pass.
- The default-on change (Task 6) is sequenced strictly after the empty-ledger guard (Task 4),
  because in the other order every existing project's `meta docs` gains a file.
