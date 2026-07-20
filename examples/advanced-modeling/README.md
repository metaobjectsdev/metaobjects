# Advanced modeling — the canonical spine

**Unit 1** of the advanced modeling series (see
`docs/superpowers/plans/2026-07-19-advanced-modeling-series-plan.md` and the
design doc at `docs/superpowers/specs/2026-07-19-advanced-modeling-series-design.md`).
A course/program publishing platform (package root `acme::learn`) that exercises
four advanced metadata patterns **together, in one model** — the interaction
between them is the thing the rest of the series teaches. This is the index
Units 2–4 (developer deep-dives, agent-context decision rules, video scripts)
all cite.

## What this is — and isn't

This directory is **authored metadata + `metaobjects.config.ts` + committed
generated output (`src/generated/**`)**, verified by a drift gate. It is
**not a runnable application** — there is no server, no database, no
`package.json`/`node_modules` for the example itself. That is a deliberate
scope boundary (see the design doc, Decision 3): a live app would buy demo
polish at the cost of a permanent maintenance tax; metadata + committed
output gives docs/agent-context/videos a real, current artifact to cite at a
fraction of the upkeep.

**The drift gate is a freshness + CLI-composition smoke check, not a
correctness gate.** It proves the committed output still matches what
`meta gen` produces right now, and that all four patterns still compose
through the real CLI path. It does **not** re-prove the patterns' *behavior*
— that is owned by `fixtures/*-conformance/` and the codegen golden tests in
`server/typescript/packages/codegen-ts/test/`. Do not describe it otherwise.

## The four patterns, and where to find them

| # | Pattern | Metadata | Generated output |
|---|---|---|---|
| 1 | **Projections** (`object.projection`, `origin.*`) | `metaobjects/meta.catalog.yaml:127-165` — `ProgramSummary`: `origin.passthrough` (a join to `Author`, `:138`), `origin.aggregate @agg:count` (`:143-146`), `origin.aggregate @agg:sum` + `filter` (`:153-157`), `origin.computed @expr` (`:163-164`) | `src/generated/ProgramSummary.ts` (the `pgView` declaration + read schema), `src/generated/ProgramSummary.routes.ts` (read-only routes — no POST/PATCH/DELETE) |
| 2 | **Entity views** (`view.*` control family) | `metaobjects/meta.catalog.yaml:25-93` — `Program`: `field.enum` (`:31-33`, → `<select>`), `view.textarea @rows` (`:40`), `field.currency` + `view.currency` (`:41-45`), `view.image` — all five attrs (`:53-58`) | `src/generated/Program.form.tsx` (select / `<textarea rows={6}>` / `<ImageUpload>` wrapped in `<Controller>`) |
| 3 | **Value objects as jsonb columns** | `metaobjects/meta.catalog.yaml:80-92` — `Program.syllabus` (array-of-VO, `isArray: true` + `storage: jsonb`) and `Program.instructorProfile` (single VO); the VOs themselves in `metaobjects/meta.content.yaml:27-47` (`SyllabusSection`, `InstructorProfile` — pure `object.value`, ADR-0028: no identity, no source) | `src/generated/Program.ts` (`jsonb("syllabus").$type<SyllabusSection[]>()`, `jsonb("instructor_profile").$type<InstructorProfile>()`); `src/generated/Program.form.tsx` (a repeatable `useFieldArray` sub-form for `syllabus`, an embedded fieldset for `instructorProfile`) |
| 4 | **Value objects as LLM/document payloads** | `metaobjects/meta.prompts.yaml` — `ProgramDescriptionPayload` (`:21-42`, an `object.value` projecting `Program`/`Author`/`Lesson` via `origin.passthrough`/`origin.aggregate`, no identity/source) + `template.output` (`:44-48`) | `src/generated/prompts.ts` (the payload interface), `src/generated/ProgramDescriptionOutput.output.ts` (tolerant parser), `src/generated/ProgramDescriptionOutput.render.ts` (typed `render<Name>()` wrapper); the mustache text lives at `templates/learn/program-description.mustache` |

`metaobjects/meta.catalog.yaml` also declares `Author` and `Purchase` — the
minimal supporting entities the four patterns above need (an FK to join
across for pattern 1; a transactional record with its own currency/enum
fields, structurally independent of `Program`'s `relationship.composition`
lessons). `metaobjects/meta.content.yaml` declares `Lesson` (the
`relationship.composition` target `ProgramSummary.lessonCount` aggregates
over).

## Regenerating

From the repo root:

```sh
cd server/typescript
bun run packages/cli/bin/meta.ts gen    --cwd ../../examples/advanced-modeling
bun run packages/cli/bin/meta.ts verify --cwd ../../examples/advanced-modeling --codegen
bun run packages/cli/bin/meta.ts verify --cwd ../../examples/advanced-modeling --templates --prompts templates
```

(`--prompts templates` is required for `--templates`: this example's mustache
lives under `templates/`, the directory the `render-helper` codegen generator
resolves at generation time — not `verify`'s own `prompts/` default. See
"Gotchas" below.)

`examples/` is **not** part of the Bun workspace (the repo-root
`package.json` globs only `server/typescript/packages/*` and
`client/web/packages/*`), so there is no local install step — the CLI's
config loader resolves the `@metaobjectsdev/*` imports in
`metaobjects.config.ts` from the CLI's own install regardless of the
example's `node_modules` (which doesn't exist).

## The drift gate

`server/typescript/packages/cli/test/integration/advanced-modeling-drift.test.ts`
runs three checks against this directory as committed:

1. `meta verify --templates --prompts templates` — the declared
   `template.output`'s mustache is drift-free against its payload VO's field
   tree.
2. `meta verify --codegen` — `src/generated/**` as committed is byte-identical
   to a fresh regen from the current metadata.
3. Every committed `.ts`/`.tsx` file under `src/generated/` parses as valid
   TypeScript (`Bun.Transpiler`, resolution-free — `examples/` has no
   `node_modules` to resolve `drizzle-orm`/`zod`/`@metaobjectsdev/react`/etc.
   against, so a full typecheck isn't available here). This check exists
   because (2) alone is a pure string diff: a generator that emits
   *deterministically* invalid syntax still "matches a fresh regen" cleanly.
   That is not hypothetical — see "Gotchas" below.

That test file lives in the `cli` package, whose full `bun test` suite is
already part of `scripts/ci-local.sh`'s `gate_conf_ts` step (the `ts-fast`
lane) — this is a **fast-lane addition to an existing package suite**, not a
new CI job, per the plan's resolved decision.

## Gotchas found building this spine

Recon-first (per the plan's Step 1) still surfaced four real issues once the
metadata actually ran through the full `meta gen` → `meta verify` pipeline —
worth recording here since they're exactly the kind of thing a from-memory
authoring pass would miss:

- **`identity.reference` does not register `@onDelete`/`@onUpdate`.**
  `docs/features/relationships.md` documents these attrs as applying to
  "both" `relationship.*` and `identity.reference`; only `relationship.*` (all
  three subtypes — `association`/`aggregation`/`composition`, each with a
  sensible default: composition→cascade, aggregation→set-null,
  association→restrict) actually has them registered. The referential action
  belongs on the relationship side (`Program.lessons` /
  `Program.purchases`), never restated on the `identity.reference` FK side.
  The doc is stale on this one point; this example follows the registered
  vocabulary, not the doc.
- **`routesFile()`/`formFile()` don't special-case a pure `object.value`.**
  `entityFile()` already renders a VO as shape-only (interface + Zod, no
  Drizzle table) — but `routesFile`/`formFile` assumed every entity has a
  backing table/entity-constants object, and would emit routes/forms
  referencing exports that don't exist for a VO. Worked around here via each
  generator's `filter` option (`metaobjects.config.ts`) rather than fixed in
  `codegen-ts`, since it's also the semantically correct call for this domain
  — none of `SyllabusSection`/`InstructorProfile`/`ProgramDescriptionPayload`
  is independently CRUD-addressable or form-submitted.
- **`render-helper`'s payload type wasn't package-stripped.** A resolved
  `@payloadRef` can arrive fully-qualified (`acme::learn::X`); every other TS-
  identifier-emitting generator (`payload-codegen.ts`, `entity-file.ts`, …)
  already calls `stripPackage()` on a resolved ref before emitting it as an
  identifier — `render-helper.ts` didn't, so a `template.output` payload in a
  named package emitted `import type { acme::learn::X } from "./acme::learn::X.js"`,
  which is not legal TypeScript. Fixed in
  `codegen-ts/src/templates/render-helper.ts` (this PR) — narrow, mirrors the
  existing pattern, covered by the existing render-helper test suite.
- **`meta verify --codegen` didn't carry the project's `templates/` dir into
  its throwaway regen root**, so any project using `render-helper()` (or
  other provider-backed template generators) would spuriously fail
  `--codegen` with an "unresolved" error unrelated to actual drift. Fixed in
  `cli/src/lib/codegen-drift.ts` (this PR) — mirrors the existing outDir-copy
  logic, extended to the templates dir.
- **A relative `outDir` resolved against the ambient `process.cwd()`, not the
  resolved `--cwd`.** `meta gen`/`meta verify --codegen` silently wrote/read
  the wrong location whenever the CLI was invoked with `--cwd` pointing
  somewhere other than the actual process working directory (exactly this
  drift gate's own invocation pattern: a `bun test` run from `packages/cli/`
  targeting `examples/advanced-modeling/`). The common case — running `meta
  gen` from inside your own project, no `--cwd` — happened to work by
  accident (`process.cwd() === projectRoot`), which is why this had gone
  unnoticed. Fixed in `codegen-ts/src/runner.ts` (the write path) and
  `cli/src/lib/codegen-drift.ts` (the read path), both anchoring a relative
  `outDir` to the resolved project root.

None of the above are metamodel vocabulary gaps (ADR-0023) — they're either a
stale doc claim or codegen/CLI bugs, fixed narrowly and covered by the
existing test suites (all four ports' conformance corpora and the `cli`/
`codegen-ts` package suites stayed green throughout).
