# ADR-0048: The Angular tier stays source-only until it meets the published-tier bar

## Status

**Accepted** (2026-08-10). Governs `@metaobjectsdev/angular`
(`client/web/packages/angular/`) and `@metaobjectsdev/codegen-ts-angular`
(`server/typescript/packages/codegen-ts-angular/`). Enforced by
`scripts/check-publish-intent.sh` (the `SOURCE_ONLY` list).

## Context

The two Angular packages were authored as a second universal browser tier
(runtime + codegen pair, mirroring React/TanStack) and versioned on their own
`0.6.x` line. `docs/RELEASING.md` defined the lockstep publish set as "every
non-`private` package at the previous version" — a non-private package on its
own version line matched neither branch, so **every release silently skipped
them and neither was ever published**, while the README, four port docs and a
full recipe described them as installable. The 0.21.5 cut corrected the docs to
"source-only" and added `check-publish-intent.sh` so the gap cannot recur
silently. That left the actual decision open: publish the tier, or keep it
source-only on purpose.

A code assessment settled it. The tier is real — the `CurrencyInputComponent`
genuinely mirrors the React `<CurrencyInput>` semantics with a behavioral test
suite, the DI fetcher token is clean, and the three generators emit plausible
standalone-component output against the cross-port REST grammar. But it is
**well below the published tier's bar**, on several independent axes:

1. **Runtime grid is not at parity.** `EntityGridComponent` renders a
   string-coercing table with a row-click callback. The TanStack `<EntityGrid>`
   it claims to mirror has controlled sorting, pagination controls, and working
   cell-renderer dispatch; the Angular component's `CellRendererRegistry`
   lookup is computed and then **discarded** (the registry is decorative), and
   its doc comment describes sort/pagination callbacks that do not exist.
2. **Form codegen predates two shipped feature lines.** Control dispatch stops
   at text/checkbox/currency — no enum `<select>`, no `view.textarea`, no
   `view.radio` (0.18.0), no `view.image` (0.19.0) — and validation is
   `required` + `maxLength` only, far short of the Zod Insert/Update semantics
   (FR-035/036) the React form enforces.
3. **Known-fixed bug classes were still live here.** The generators lacked the
   0.21.5 `servesReadApi`/`servesWriteApi` endpoint guards (emitting
   services/forms for `object.value`, sourceless and abstract objects — output
   that cannot compile), and the generated service imports the entity module
   **value**, dragging the DB layer into a browser bundle — the exact defect
   0.21.5 fixed for the TanStack tier via the DB-free `<Entity>.meta`
   descriptor. (The guard half is fixed alongside this ADR; the descriptor
   import and TPH handling are not.)
4. **The behavioral test suite cannot run in the repo's toolchain.** *(This
   diagnosis is wrong — see Amendment 1. The suite runs; the cause was a
   tsconfig option Bun discards, not the linker.)* Angular's
   standard field decorators require the Angular linker (AOT); Bun's test
   runner has no plugin phase to run it, so the suite fails structurally
   (`Standard Angular field decorators are not supported in JIT mode`). Only
   the #287 browser-bundle gate runs in CI, by name. Fixing this means adopting
   Angular's own test tooling — a second test toolchain for one package.
5. **The peer ranges promised four untested majors** (`>=18 <23`, built and
   tested on 18.2) — the "package promising a compatibility it never had"
   family the 0.21.5 cut was about. (Narrowed to `<19` alongside this ADR.)
6. **No demand signal.** No consumer has asked for the npm package; the tier
   has no conformance-lane presence and no compile gate over its generated
   output (the codegen tests are text-containment asserts).

Publishing — including the "preview `next` dist-tag" middle road — claims the
npm names, creates an adopter support surface, and adds a publish lane to every
coordinated release cut (they are frequent), all for a tier in this state.
Moving it out of the repo would lose the gates that have kept it honest (the
browser-bundle gate, the ADR-0039 accessor sweeps, the peer-range gate) and
contradict the chartered monorepo layout, which names
`client/web/packages/angular/` as exactly where an Angular integration lives.

## Decision

**The Angular tier stays in-repo and source-only, as a deliberate position.**
Concretely:

- Both packages remain **non-`private`** and listed in
  `check-publish-intent.sh`'s `SOURCE_ONLY` set. That gate — not
  `private: true` — is the mechanism: it keeps the invariant *checked* (a
  drift onto the lockstep version while listed source-only fails the build)
  and keeps the promotion path one explicit step (remove from the list).
  `private: true` would make npm refuse `publish` outright, but it would also
  drop the packages out of the gate's view and mis-state the intent — these
  are publishable-later packages consumed from source today, not
  never-publish internals like `forge`/`conformance`.
- They stay on their own `0.6.x` version line, never the lockstep version.
- No `next`/preview dist-tag publish. The preview channel for a source-only
  tier in a public repo is the repo itself.
- Release cuts do **not** touch them. Their absence from the
  `docs/RELEASING.md` tier table is intentional.

## The promotion bar

Publishing the tier is a deliberate future feature, not a release-mechanics
step. All of the following before the packages join lockstep:

1. Runtime grid parity with the TanStack tier: working cell-renderer dispatch,
   sortable headers, pagination controls.
2. Form codegen at the shipped view-kind bar: enum `<select>`,
   `view.textarea`, `view.checkbox`/`view.radio` dispatch (image support may
   be explicitly scoped out), and validation semantics reconciled with
   FR-035/036.
3. Generator parity with the other UI tiers: TPH handling, read-only service
   surface for projections (no write methods against routes that do not
   exist), and generated services importing the DB-free `<Entity>.meta`
   descriptor — gated by a browser-bundle test over generated output.
4. A test runner that actually executes the runtime behavioral suite
   (~~Angular linker toolchain~~ — **met 2026-09-06**, with no new toolchain;
   see Amendment 1), wired into CI, plus a compile gate over generated output
   against `@angular/core` — **this second half is still open**.
5. Peer ranges covering only tested Angular majors.
6. A real consumer asking for the npm package.

Then, mechanically: bump both to the lockstep version, remove them from
`SOURCE_ONLY`, add them to the `docs/RELEASING.md` tier table (codegen in
tier 2, runtime in tier 3), and flip the "source-only" notes in README.md,
CLAUDE.md, `docs/ports/typescript-client.md`, the three backend port docs and
`docs/recipes/csharp-angular18.md`.

## Consequences

- Nothing an adopter can install is promised and unowned: the docs say
  source-only, the registry says 404, and both statements agree.
- The tier keeps riding the repo's mechanical gates (build, typecheck,
  browser-bundle, peer-range, publish-intent) for free, so it stays buildable
  without pretending its suite is green.
- The feature-drift cost is accepted and visible: sweeps (accessor discipline,
  peer ranges) reach it; feature lines (view kinds, meta descriptors, TPH) are
  not required to, until someone picks up the promotion bar.
- Anyone proposing to publish it has a checklist instead of an argument.

## Amendment 1 — the untestable suite was a tsconfig option, not a toolchain (2026-09-06)

Context item 4 and the first half of bar item 4 priced the behavioral suite at a
second, permanent test toolchain for one package: Angular's linker, or TestBed
under Karma/Vitest. That price was wrong. The suite now executes under plain
`bun test` — 21 tests across the package, 0 failing — and the whole package is
back in `gate_ts_unit`'s client loop rather than being run by named file.

Two independent things were being conflated, and only one of them was ever real:

- **The linker was not needed in-process.** `test/setup.ts` already imported
  `@angular/compiler`, whose JIT compiler resolves the `ɵɵngDeclare*` declarations
  in Angular's shipped fesm2022 bundles — the work the linker would otherwise do
  ahead of time. Nothing else was required for `@angular/common` to load.
- **The actual wall was `extends`.** Bun (measured on 1.3.14) takes
  `experimentalDecorators` from the base of a tsconfig `extends` that RESOLVES and
  discards the child's own value; an `extends` naming a missing file keeps it.
  `tsc` is unaffected. So the package's `extends` to the shared server base — which
  says nothing about decorators — silently forced standard decorators on every
  `bun test`, and Angular 18's `@Input()` threw
  `Standard Angular field decorators are not supported in JIT mode.` at the first
  import of the barrel. Inlining the base into
  `client/web/packages/angular/tsconfig.json` and setting
  `experimentalDecorators: true` removes it; the file says so at length, because
  re-adding `extends` un-runs the suite.

**It was also a product defect, not only a test gap.** The tier built with
`experimentalDecorators: false`, so `tsc` emitted standard decorators into
`dist/index.js` and *no* Angular consumer could import the built package — the same
throw, from the artifact an adopter would actually load. Nothing caught it because
nothing in the repo imported the built barrel: the browser-bundle gate proves a
bundler can resolve the graph, which it can, and the by-named-file test lane
deliberately skipped the one file that would have imported it. That is the shape
worth remembering — a lane narrowed to route around a failure stops being able to
see what the failure was about.

**The decision does not change.** Bar items 1, 2, 3, 5 and 6 stand, and so does the
compile gate over generated output in item 4. The tier stays source-only; what
changed is that one of the six is now cheap and done, and the reason the other five
are open is feature parity rather than tooling.
