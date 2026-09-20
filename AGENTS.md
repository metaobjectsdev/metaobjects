# MetaObjects — Claude Context

## What this project is

MetaObjects is a **cross-language metadata standard** for declaring typed entity models that drive code generation, runtime metadata access, and drift detection — across TypeScript, C#, Java, Python, and Kotlin (Kotlin runs on the JVM via `metadata-ktx` + `codegen-kotlin`).

The metamodel is the **durable spine**; generated code is the **disposable artifact**. Substrate is local-first: typed metadata lives in your repo, generated code is idiomatic per-language output that runs without any MetaObjects dependency at runtime. If `@metaobjectsdev/*` disappears tomorrow, you keep working code.

## Six pillars

The first four ship per-language today across the five ports (TS / C# / Java / Python / Kotlin), with cross-port conformance corpora verifying byte-identical behavior. The fifth ships its vocabulary in every port, its `meta verify` checks in the Node `meta` CLI, and its test scaffolding in TypeScript only. The sixth is content the other five compose, shipped as named opt-in artifacts:

1. **Codegen** — emit idiomatic per-language code (Drizzle/Zod + Fastify for TS, EF Core + ASP.NET for C#, Spring REST + DTO + Repository for Java via `codegen-spring`, Pydantic + FastAPI for Python, KotlinPoet + Exposed + Spring for Kotlin via `codegen-kotlin`). Hand-edit-preserving regen via three-way merge.
2. **Runtime metadata** — load metadata at runtime, drive behavior dynamically (CRUD, validation, relationships, dynamic admin UIs, LLM tool registration). On Kysely (TS), a DB-API 2 driver via ObjectManager (Python), modernized JDBC + Spring-tx via OMDB (Java), Exposed (Kotlin), EF Core (C#).
3. **Drift detection** — `meta verify` catches divergence between code and metadata (covers entity codegen, prompt templates, output parsers, schema). Quality-of-life on top of codegen + runtime.
4. **Prompt construction** — a prompt is code, not a string scattered across services. Declare a prompt's payload as a typed projection (payload bloat becomes a diff), keep its text external and provider-resolved, and render it deterministically: snapshot-testable, cache-stable (no whitespace change silently breaking exact-prefix prompt-cache hits), and drift-checked at build time so a renamed field can't degrade a prompt. Conformance-gated, so the guarantee holds in every language port. **Render + payload-VO codegen + `verify` + parser-on-receipt for a *responding* `template.prompt` — one carrying `@responseRef` (FR-006) — + the output-format prompt fragment & tolerant `extract` parser (FR-010) ship in all five ports today** (since 0.24.0 the whole inbound tier keys off `@responseRef`; a `template.output` is outbound-only and emits no parser — ADR-0052) — the library-side building blocks of the pillar are complete. The one remaining library-side piece is MCP exposure of declared prompts/tools (see `spec/roadmap.md`); the application-level consolidation (eval harness, end-to-end declared-prompt orchestration) and consumer adoption are exercised in adopter projects, not in this library repo. Designed in `docs/superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md`.
5. **Requirements and testing** — declare what the software is supposed to *do* in the same model as the entities, so a capability claim is checkable instead of prose. The other four pillars keep the code honest about the *model*; this one asks whether the thing you said the software does is actually built — an absence no test can fail on, because a test exercises code that exists. `requirement.functional` (existence: `meta verify` WARNS when nothing implements it) and `requirement.architectural` (universality: `meta verify` FAILS a live policy applied to nothing, and does not check that each claimed node complies) are registered vocabulary in all five ports, with the loader enforcing the closed `@status` enum. `@implementedBy` is **resolved, not trusted** — it names a real member of the real model, so a claim whose implementation was renamed or deleted fails the build instead of going quietly stale. `meta verify` reports the ledger on every run (unresolved links, entities no claim covers, gaps recorded versus gaps nobody has ruled on) plus an authoring lint whose findings can never fail a build; `meta docs` renders it for humans and for agents. **The port split, stated exactly: the vocabulary loads and validates in all five ports; the `meta verify` checks run in the Node `meta` CLI only (no other port's CLI runs them — `docs/CONFORMANCE.md` "Split coverage"); `requirementTests()` — which scaffolds a test stub per claim — is TypeScript-only.** A green run proves referential integrity, never that a status is true or an implementation correct (`docs/features/requirements.md`, "What a green run does not prove"). A project that declares no `requirement.*` nodes sees no change at all. Note the standing carve-out: `agent-context/skills/metaobjects-fit-assessment/SKILL.md` deliberately does NOT treat `requirement.*` as an assessment axis — see the ruling in that file before "finishing the job" there.

6. **Libraries** — reusable declared design, shipped as metadata and opted into by name (`"libraries": ["iam"]` in `.metaobjects/config.json`). Not a sixth verb: a library is the **reuse unit that composes the other five** — entities, requirements, the generators its design implies, its runtime packages — as one named, opt-in, drift-gated artifact. What makes it a pillar rather than a folder of YAML is the fifth: without requirements a library is a schema snippet; with them it is design an adopter's build is held to, which is the same test the requirements pillar passes (*does it change what an agent can be checked against?*). **A library is LAYERED and its core layer is INERT** — the core declares no `source.rdb`, and a sourceless object generates nothing and migrates to nothing (#248), so `["iam"]` adds zero tables and zero generated code while making the design present and resolvable; `["iam", "iam/db"]` is the separate opt-in that proposes the schema. **Copy is the expected mode** (`meta eject <library>` — ADR-0034's ruling applied to metadata), and an ejected copy still named in `libraries` is refused at load (`ERR_LIBRARY_PACKAGE_COLLISION`) rather than merging asymmetrically. Object coverage activates on ADOPTER-authored requirements only, so a library cannot volunteer a project for a gate it did not ask for. `iam` (preview) and `ai` (stable) ship today; rows appear in `meta gen --list` beside the generators. See [docs/features/libraries.md](docs/features/libraries.md) and `docs/superpowers/specs/2026-09-13-fr-043-feature-and-nfr-packages-design.md`.

## Status

_Last refreshed 2026-09-14._

**1.0 gating — the quiet period is RETIRED (2026-09-06).** `docs/1.0-readiness.md` §G3 no
longer asks for "one coordinated release with no metamodel-breaking change." It measured a
variable the maintainer sets, and it had already converged — `metamodelVersion` held at `0.13`
across `v0.24.2`–`v0.24.5`, four consecutive releases — before `0.25.0` spent the breaking slot
by decision. It is replaced by **G3a** (declared scope covered, nothing outstanding needs new
vocabulary — **DECLARED 2026-09-07**), **G3b** (DONE — `docs/compatibility-policy.md` carries
the *correction bar*: the three-part test under which input that never had a valid meaning may
stop loading in a PATCH, explicitly NOT covering retirement of vocabulary that worked), **G3c**
(DONE — the migration guide and compat policy are current at the cut) and **G3d** (OPEN, and the
one gate now blocking the cut — an adopter estate must run the RELEASE CANDIDATE with the drift
gate ENFORCED before promote; ruled 2026-09-07 knowing all six adopters are maintainer-owned,
because a conformance corpus gates the ports against each other and never against use). Ruling
in ADR-0035 **Amendment 3**. Do not reintroduce a waiting gate in any form.


**Where the versions are.** `latest` is **`1.0.4`** on npm, **`8.0.4`** on Maven Central,
**`1.0.4`** on PyPI and **`1.0.4`** on NuGet (the Maven major is always **npm major + 7**, so
1.0.4 is 8.0.4). All four moved at 1.0.4, as they did at 1.0.3: every port had changed product
code. **1.0 is CUT**: the `1.0.0-rc.5` through `rc.8` candidates and 1.0.4's `rc.1` are
superseded, and npm's `next` tag is REPOINTED onto each release — not deleted, because
`dist-tag rm` 403s for every token we hold (`docs/RELEASING.md` §4).
`metamodelVersion` reads **`1.0`**, frozen — C4 landed and G4 shipped it, and no 1.0.x patch
has moved it (1.0.4 relaxed `@sourceRefField` onto `@cardinality: one` with a prose-only
manifest footprint, and was ruled a hold). Per-release detail lives in **`CHANGELOG.md`** — it is the log, and this file does
not duplicate it.

The npm surface is **14 `@metaobjectsdev/*` packages in full lockstep**; the two `angular`
packages are on their own `0.6.x` line and are **not published — source-only by decision**
(ADR-0048). They build in-repo and stay off the registry until they meet that ADR's promotion
bar.

**A lagging version number is INFORMATION, not drift.** Since `0.24.5` a registry publishes
only when it has a changed product file, and when it does it adopts the shared `minor.patch`
then current, skipping the numbers it sat out (ADR-0035 Amendment 1, operative table in
`docs/RELEASING.md`). Two carve-outs: the 14 npm packages move atomically with each other, and
a change to `expected-registry.json` / `metamodelVersion` still forces all four, because that
is the contract every port byte-matches. So PyPI at `0.25.0` while npm is at `0.25.2` says
PyPI has had no product change since `0.25.0` — nothing is broken.

**All five ports ship loader + canonical serializer + conformance + codegen + render + payload-VO + `verify`:**

- **TypeScript** — `codegen-ts` (Vite-style plugins; Drizzle, Zod, Fastify) + `runtime-ts` + `migrate-ts` + the universal web client packages (`runtime-web`, `react`, `tanstack`).
- **C#** — `MetaObjects` (loader + canonical serializer + conformance) + `MetaObjects.Render` (Mustache + payload-VO + `verify`) + `MetaObjects.Codegen` (EF Core entities + `AppDbContext` + CRUD minimal-API routes). Schema migrations are TS-owned (ADR-0015): the C# migrate engine and the `migrate`/`--from-db` CLI surface were removed; the C# CLI is `gen`/`verify` only, packaged as a .NET tool invoked **`dotnet meta`** (not a bare `meta` — that name belongs to the Node schema CLI). EF Core runtime data-access stays per-port.
- **Java** — `metadata` + `omdb` + `om` + `dynamic` + `core-spring` + `metadata-ktx` (Kotlin facade) + `codegen-spring` (Spring controllers + DTOs + repositories + filter allowlists + payload records + output parsers) + `codegen-mustache` + `codegen-plantuml` + `render` + `maven-plugin` (`metaobjects:generate`/`metaobjects:editor` + a `metaobjects:verify` **codegen-drift** goal — distinct from the removed live-DB `metaobjects:verify`; Kotlin generators run through `metaobjects:generate` via the shared SPI). FR-003 (OMDB runtime persistence + binding registry + typed jsonb + Spring-tx + source/origin metamodel) fully shipped, including Plan 4 (engine-debt remediation: atomic mapping cache, JDBC codec registry, `inTransaction` template). **Schema migrations are owned by the TypeScript toolchain** (`@metaobjectsdev/cli migrate`); the Java port's diff-and-converge migration engine and its `metaobjects:migrate` / live-DB-drift `metaobjects:verify` Maven goals were removed, and per ADR-0015 Decision 2 the dev/test runtime auto-create path (`MetaClassDBValidatorService` + the drivers' `createTable`/`createIndex`/`createForeignKey`/`createSequence` DDL) is **also** removed — **OMDB is pure data-access** (CRUD/query/codec/transactions only).
- **Python** — `metaobjects` (loader + canonical serializer + conformance + render + verify + codegen) + an `ObjectManager` runtime layer. The `migrate` module was removed (schema is TS-owned, ADR-0015); Python is pure data-access (codegen + ObjectManager runtime), with a **`metaobjects` console-script** (`gen`/`verify` codegen — no `migrate`). All five conformance corpora green.
- **Kotlin** — `codegen-kotlin` (KotlinPoet on JVM): entity + Exposed table + Spring controller + payload + relations + filter allowlist + validator + stored-proc + output-parser generators. `integration-tests-kotlin` runs the persistence-conformance corpus through Exposed against Testcontainers Postgres.

**Cross-port conformance corpora** (every port runs the shared corpus):
- Metamodel: `fixtures/conformance/` (329 fixtures; 22 shared corpora in total — per-corpus counts + the corpus x port matrix live in `docs/CONFORMANCE.md`). TS / C# / Java / Python all green.
- Render: `fixtures/render-conformance/`. TS / C# / Java / Kotlin / Python byte-identical.
- Persistence: `fixtures/persistence-conformance/`. **Query** scenarios run on every port (TS / C# / Java / Kotlin / Python), each provisioning its test DB by executing the committed, TS-produced `canonical/schema.postgres.sql` (Postgres only — Derby dropped for the cross-port query corpus, ADR-0015). The **migration** scenarios are exercised by **TS only** (TS owns schema migrations). **The corpus now gates WRITES, not just reads (SP-H):** an `op: roundtrip` scenario type INSERTs through each port's runtime/ORM write codec (NOT raw SQL), reads the row back, and asserts the wire-normalized value. The `AllTypes` entity (`roundtrip-all-types.yaml`) carries one field of **every** persistable `field.*` subtype — string/int/long/double/float/decimal/boolean/date/time/timestamp(+tz)/currency/enum/uuid/object — plus an **array-of-VO** `field.object @isArray @storage:jsonb` column (`labels`, written as 2-element / empty-`[]` / single-element arrays across the three rows) — so every subtype write+read (incl. the array-of-value-object jsonb codec) round-trips through every port against Testcontainers PG. (`field.byte`/`field.short`/`field.class` were cut as non-functional registration-only stubs — the matrix tracks only genuinely-supported subtypes; see `fixtures/registry-conformance/README.md` → "Per-subtype write-round-trip matrix".)
- API-contract: `fixtures/api-contract-conformance/`. TS / C# / Java / Kotlin / Python all green — each port runs **two lanes**: a hand-rolled reference server AND its **generated** API artifact booted over HTTP (the deployed controller/routes; TS+C# full-stack vs Testcontainers PG, Java/Kotlin/Python generated controller + in-memory repo behind the consumer seam). The generated fan-out found 10 real deployment bugs golden snapshots missed. The `m2m/` sub-corpus also gates **TPH x M:N together** (base-declared, subtype-declared, abstract-mid-declared, a non-subtype source onto a subtype TARGET, and the cross-subtype source id answering `200 []`) — the two corpora were originally built disjoint (`tph/` had no relationships, `m2m/` no discriminators), which is precisely how that defect class survived.
- YAML / verify corpora green across the ports that ship those layers.
- **Codegen-compile gate** (all five ports; a GATE, not a corpus — it has no fixtures of its own and no row in the matrix). Every corpus above gates BEHAVIOUR; none asks whether the emitted code BUILDS, which is how four "generated code does not compile" defects shipped in 1.0.4 with the whole matrix green — `gen` exits 0 in all four cases and the adopter's build is the first thing that disagrees. Each port generates from `fixtures/persistence-conformance/canonical/meta.fitness.json` (reused deliberately: a second kitchen sink would drift from the one the other corpora already maintain) and compiles the emitted tree with its real compiler — `ts.createProgram` / Roslyn / `javac` / `KotlinCompilation` / (Python, having no static compiler) importing the generated package plus `ruff` F821. **Every port excludes its framework-bound route tier** (TS `routesFile`, C# `RoutesGenerator`, Java `SpringControllerGenerator`, Kotlin `KotlinSpringControllerGenerator`): those imports are not on an in-memory compile's classpath and stubbing them drowns the signal, so that tier is proven by the api-contract integration lane instead. One cross-port rule, not four local concessions. Found 5 further real defects on first run. Boundary detail: `docs/CONFORMANCE.md` → "Split coverage".

**Key cross-language features shipped:** FR5 family (a/b/c/d/e + WARN envelope-shape — actionable loader errors per ADR-0009); FR-003 (Java RDB runtime persistence + projections; schema migrations are TS-only — the Java migration engine was removed); FR-006 (template.output parser-on-receipt codegen per ADR-0010 in all 5 ports); FR-008 + FR-009 (cross-port REST API contract + the nine filter operators); FR-018 (M:N relationship codegen in all 5 ports — entity navigation + idiomatic ORM wiring [Drizzle m2m / EF Core `UsingEntity` / Spring repo+JPA / Exposed / Pydantic+route as the SQLAlchemy-secondary equivalent] + REST traversal `GET /<source-plural>/{id}/<relation>` + Tier-2 docs, gated by the shared api-contract m2m corpus in both lanes + persistence-conformance; the TanStack M:N client hook is a deferred client-ergonomics follow-up); SP-H (field-subtype end-to-end hardening: every concrete `field.*` subtype write+read round-trips cross-port via the persistence `op: roundtrip` gate; cut `field.byte`/`field.short`/`field.class` non-functional stubs; cross-port filter-op reconciliation for uuid/currency); source v2 paradigm (ADR-0007); metadata-ktx Kotlin facade; per-target output directories (TS codegen).

**Latest release: 1.0.4** (2026-09-14) — npm `1.0.4`, Maven Central `8.0.4`, PyPI `1.0.4`, NuGet `1.0.4`; a coordinated PATCH with changed product code in every port. Carries FR-043 **libraries** (the sixth pillar — `iam` preview, `ai` stable, layered with an inert core), codegen made **opt-in** in every port (ADR-0034 Amendment 2 — no default generator suite; `meta gen --list` is the catalog, `--probe` answers it against the project), multi-name `meta eject`, the #367 auth seam printed in generated routes, the #368 fix for two `identity.reference` nodes onto one target, and M:N relationships inherited through `extends` deriving against the declaring entity. **It changes generated output**: adopters with committed generated code must run `meta gen`, and for most the diff is comments only.

See `spec/roadmap.md` for the active + planned work picture.

## Public repository hygiene

**This repository is PUBLIC.** Never commit references to other/private projects or to a developer's local environment. In any committed file — specs, plans, code, docs, fixtures — before every commit:

- **No other-project names.** Do not name private or sibling consumer projects. Use generic terms: "a downstream consumer", "the reference web consumer", "a C# adopter", "a sibling project".
- **No absolute local paths.** Never commit a developer's home path (e.g. `/home/<user>/…` or a `~/`-rooted path). Use repo-relative paths or placeholders (`<repo-root>`, `<consumer-repo>`) in command examples.
- **Scan the staged diff** for both of the above and genericize anything found before committing.

A local pre-commit hook enforces this (`.githooks/pre-commit`). The committed hook names **no** private project: it enforces generic structural patterns (absolute home paths) and loads a private-name denylist from a path you configure (kept in a private repo, never here). One-time per clone:

```
git config core.hooksPath .githooks
git config hooks.denyListPath /path/to/your/private/denylist.txt
```

It blocks commits whose added lines match (`git commit --no-verify` bypasses, discouraged); the npm author email is the one allowed exception. Guard a new private name by editing that private denylist (single source of truth) — never add real names to this public repo or the committed hook.

**Pre-push typecheck gate** (`.githooks/pre-push`, same `core.hooksPath`): `bun test`
transpiles per-file and does NOT typecheck, so type-broken code can ship green on the
test suite while `bun run --filter '*' typecheck` — the same check `scripts/ci-local.sh`
runs — goes red, and a direct admin push to `main` bypasses branch protection. This hook closes that hole locally: when a push touches
`server/typescript/` or `client/web/`, it runs that same `bun run --filter '*' build &&
… typecheck` pair and **blocks the push when it is red** (~6s on a clean tree;
skipped entirely for non-TS pushes). Bypass in an emergency with `git push --no-verify`
or `SKIP_TS_TYPECHECK=1 git push`.

**GitHub Actions is DISABLED on this repository (2026-09-16) — every check runs locally.**
The workflow files are kept and unchanged, because the switch is reversible, but nothing in
`.github/workflows/` fires today: not `hygiene.yml`'s leak scan on a PR, not `conformance.yml`'s
nightly + `v*`-tag matrix, and not `local-ci.yml` on the self-hosted runner. **`scripts/ci-local.sh`
is now the only thing that runs them**, and it already mirrors all three — `--quick` covers
`hygiene.yml` in full plus the TypeScript half of `conformance.yml`, and the flagless full run
adds the C#/Java/Kotlin/Python conformance lanes, the Java reactor and `integration-tests.yml`'s
Testcontainers matrix. Run `--quick` before opening a PR and the full script before a tag;
`MO_CI_LIST_ONLY=1 scripts/ci-local.sh [flags]` prints what a selection would run without
running it. The no-mistakes validation gate runs the script for you — see `.no-mistakes.yaml`,
whose `lint` and `test` commands partition `--quick` between the two steps. That file is read
from the **default branch**, so it does nothing until it is merged to `main`.

**A green `leak-scan` check on a PR is a LOCAL scan, not a hosted one.** `main`'s protection
requires that one status, and `hygiene.yml` was the only thing that ever published it — so with
Actions off, nothing could merge. Rather than weaken the rule, `scripts/publish-leak-scan-status.sh`
runs `.githooks/leak-scan.sh` and reports that exact result as the `leak-scan` commit status,
bound to the SHA it scanned. Run it after pushing, once per head you want mergeable. It publishes
the real verdict only — a failed scan publishes `failure` — and refuses outright on a dirty tree,
on a HEAD that moved mid-scan, or with no credential. The status description repeats the caveat,
so the PR page carries it too. No hosted scan runs while Actions is off, on any branch.

**Lane selection is "not known-green", not "affected"** (`scripts/ci-ports-to-run.sh`).
This is how `local-ci.yml` chooses its lanes, so it is dormant while Actions is off — but
it is still committed and still gated, and it is what resumes if Actions comes back.
The selector unions the ports this push touched (`scripts/ci-affected-ports.sh`) with
the ports whose *newest* verdict on `main` is not a success, read from the workflow's
own run history — so a stale red lane gets **re-run**, not merely reported. Affected
alone has a hole that bit during the 1.0.1 cut: five lanes failed, the next commit was
docs-only, its run skipped every code lane and reported green, and the red sat
unverified under a green tip. `skipped` is walked past (it describes the selection, not
the code); anything that is not `success` — `cancelled` included — and any lane with no
verdict in the window counts as not-green, because the selector may only ever widen.
Both selector scripts are tested by the `ci lane selection` gate in the `gates` lane,
which also asserts the lane→port map against the workflow's real job list.

## Monorepo layout

This repo holds all implementations of the standard, organized by deployment target → language/platform → framework integration:

```
metaobjects/
├── spec/                          # canonical metamodel docs (target-agnostic)
├── fixtures/conformance/          # cross-language test fixtures
│
├── server/                        # runs on a server
│   ├── typescript/   java/   python/   csharp/
│
└── client/                        # runs on an end-user device
    ├── web/                       # browser (TS-only — the browser is TS-native)
    └── ios/  android/             # future
```

**TypeScript plays two distinct roles**, and the layout reflects that:
- **Server-side TS** is a peer port to Java/Python/C# at `server/typescript/`.
- **Universal web client TS** at `client/web/` is consumed by ALL backends (a Java backend serving React still uses the TS client packages).

**Where does a new package go?**
1. Server-side or client-side? → top-level dir.
2. What language/platform? → second-level dir.
3. What framework integration? → package name at the third level.

Worked examples: a Drizzle TS-server integration → `server/typescript/packages/...`; an Angular browser integration → `client/web/packages/angular/`; future iOS SwiftUI → `client/ios/packages/swiftui/`.

## TS package layout

**Server-side** (`server/typescript/packages/`):
- `metadata/` (`@metaobjectsdev/metadata`) — metamodel loader, types, constants
- `codegen-ts/` (`@metaobjectsdev/codegen-ts`) — framework-neutral TS codegen engine (entityFile, queriesFile, routesFile, barrel)
- `codegen-ts-react/` (`@metaobjectsdev/codegen-ts-react`) — React codegen (formFile)
- `codegen-ts-tanstack/` (`@metaobjectsdev/codegen-ts-tanstack`) — TanStack codegen (tanstackQuery, tanstackGrid, tanstackGridHook)
- `runtime-ts/` (`@metaobjectsdev/runtime-ts`) — Node-side runtime (Kysely, Drizzle, Fastify helpers)
- `migrate-ts/` (`@metaobjectsdev/migrate-ts`) — migration tooling
- `sdk/` (`@metaobjectsdev/sdk`) — workspace memory, path helpers
- `cli/` (`@metaobjectsdev/cli`, binary `meta`) — CLI commands: `init`, `gen`, `migrate`

**Client-side / universal web** (`client/web/packages/`):
- `runtime-web/` (`@metaobjectsdev/runtime-web`) — pure framework-agnostic browser core (currency, filter-qs, EntityFetcher contract, GridConfig). Zero React, zero TanStack.
- `react/` (`@metaobjectsdev/react`) — React runtime: `useEntityForm`, `<CurrencyInput>`.
- `tanstack/` (`@metaobjectsdev/tanstack`) — TanStack runtime: `EntityFetcherProvider`, `<EntityGrid>`, default cell renderers.
- MetaObjects does not add a first-party package per framework. React ships a codegen+runtime pair;
  Angular ships source-only (ADR-0048's promotion bar). Any other framework is reached by owning and
  retargeting the generators (FR-040), not by waiting for an official package.

### Framework integration: separate codegen and runtime packages

Each framework integration ships as a **pair** of packages — one for codegen (server-side, runs at `meta gen` time) and one for runtime (browser-side, runs in the user's app). Mirrors Prisma (`prisma` + `@prisma/client`), Apollo (`@apollo/codegen-cli` + `@apollo/client`), and Drizzle (`drizzle-kit` + `drizzle-orm`).

| Integration | Codegen | Runtime |
|---|---|---|
| React | `@metaobjectsdev/codegen-ts-react` | `@metaobjectsdev/react` |
| TanStack (depends on React) | `@metaobjectsdev/codegen-ts-tanstack` | `@metaobjectsdev/tanstack` |

Each codegen package emits imports that target its matching runtime package. Codegen packages live under `server/typescript/packages/` because they execute server-side, even though their output targets the browser. Runtime packages live under `client/web/packages/` and have zero Node-only deps.

Two disjoint dependency trees:

```
Runtime side (browser):              Codegen side (server):

  @metaobjectsdev/runtime-web ←┐         @metaobjectsdev/codegen-ts ←┐
        ↑                    \              ↑                   \
        └── @metaobjectsdev/react ┐             ├── @metaobjectsdev/codegen-ts-react
                ↑               \            └── @metaobjectsdev/codegen-ts-tanstack
                └── @metaobjectsdev/tanstack
```

The two-package split is the shape a first-party integration takes when there is one — it is not a
commitment to add more. Reaching another framework is an ownership move, not a roadmap item: eject
the generator and retarget its emit (FR-040).

A user's `metaobjects.config.ts`:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
// Owned generators, copied in by `meta eject` (ADR-0034 scaffold-and-own; `meta init` wires none).
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { routesFile } from "./codegen/generators/routes";
import { barrel } from "./codegen/generators/barrel";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackQuery, tanstackGrid } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  generators: [entityFile(), queriesFile(), routesFile(), formFile(), tanstackQuery(), tanstackGrid(), barrel()],
});
```

A consumer's React component:

```ts
import { formatCurrency } from "@metaobjectsdev/runtime-web";
import { CurrencyInput, useEntityForm } from "@metaobjectsdev/react";
import { EntityFetcherProvider, EntityGrid } from "@metaobjectsdev/tanstack";
```

## Other conventions

- **TS runtime**: Bun-first for development (zero-config TS, native test runner). Node-compatible for distribution; users install via npm/pnpm/bun without lock-in to Bun's runtime.
- **Module system**: ESM only. No CommonJS, no transpile step required.
- **Storage format**: JSON files in `metaobjects/meta.<concept>.json` at project root. `.metaobjects/.gen-state/` holds the codegen merge base: the snapshot **bodies are gitignored** (a second full copy of all generated output), but **`.hashes.json` is COMMITTED** — one hash per generated path, and the only thing that lets `meta gen` tell "this file is exactly what I wrote" from "somebody edited this" on a machine that did not generate it. Ignore it and a fresh clone or CI runner silently overwrites hand edits; commit it and an edited file is refused by name instead.
- **Codegen substrate**: ts-poet for greenfield emit, ts-morph for in-place edits, Biome for format pass, `git merge-file --diff3` for hand-edit-preserving regen.
- **Runtime substrate**: Kysely for TS (user-provided connection, async-only).
- **Migration substrate**: Postgres + SQLite for TS v0.3.
- **Metadata location**: resolved via `resolveCollection()` (`@metaobjectsdev/sdk`) — the single authority. `metaobjects/` is the **default value of `sources`** and nothing else: no other module, command or user-facing message may assert that a directory of that name exists or is where metadata lives. Exactly five sites may name it — `sdk/src/metadata-files.ts` (`DEFAULT_METADATA_DIR`, its single definition), `sdk/src/sources.ts` (`DEFAULT_SOURCES`, **the** default), `sdk/src/collection.ts` (inside `resolveCollection`, *applying* that default), `sdk/src/index.ts` (the barrel re-export of the constant, no use), and `cli/src/commands/init.ts` (the scaffolder **writing** the layout). Enforced by `sdk/test/no-hardcoded-metadata-dir.test.ts`, whose allowlist demands a written reason per entry. See [docs/features/metadata-sources.md](docs/features/metadata-sources.md).

## Explicitly out of scope

- A custom DSL. Plain typed metadata only — Wasp's seven-year DSL-tax is the cautionary tale.
- A spec-driven workflow like Kiro / Spec Kit. Humans don't author rich specs; Claude proposes metadata, humans review.
- A proprietary runtime. All generated code runs without MetaObjects installed; runtime libraries are normal language-native packages.
- A prompt-to-app builder (not Lovable, Bolt, or v0). MetaObjects generates entity-shaped boilerplate; users hand-write the interesting business logic.
- Replacing CLAUDE.md, cursor rules, or other prompt-engineering surfaces — MetaObjects complements them.
- An LLM provider. The MCP integration is model-agnostic.
- An AI agent platform. (Codegen Inc. died Jan 2026 trying that.)

## Working with Claude on this project

- For new features or non-trivial changes, prefer the **brainstorming → plan → implementation** flow. Don't jump to implementation without a plan.
- Entity records are **prescriptive** (drive codegen + runtime). The other record types (decision, principle, convention, glossary, failure) are **descriptive** (supporting context for reasoning).
- Confidence and provenance are first-class on memory records. Bias toward under-flagging on drift checks (false-positive rate >15% is a kill criterion).
- Templates are user-owned plain TS. Anything inside a generated file is fair game to hand-edit; three-way merge preserves it.
- TDD discipline throughout implementation.
- **Cross-language conformance fixtures** live at `fixtures/conformance/`. Adding new metamodel behavior means adding a conformance fixture so every language port (TS, Java, Python, C#) automatically verifies it. See `spec/conformance-tests.md` for the fixture format and canonical serializer contract.

## File organization

**Default convention**: one file per domain concept under `metaobjects/`. Multiple objects per file when they share a domain. Projections (`source.dbView`) live inline with their base entity.

`metaobjects/` is the **default value** of `sources` in `.metaobjects/config.json` — never a requirement. A project declaring `sources` explicitly can point anywhere (and need not have such a directory at all); `"sources": []`, which is what `meta init` scaffolds, takes the default.

```
project-root/
├── metaobjects/                       # VISIBLE — entity declarations
│   ├── meta.common.json               # shared abstracts (BaseEntity)
│   ├── meta.commerce.json             # Program, Purchase, ProgramSummary
│   ├── meta.users.json                # Subscriber
│   └── meta.content.json             # Video, Week, Workout, Exercise
├── .metaobjects/                      # HIDDEN — tool state
│   ├── config.json                    # static project state
│   └── .gen-state/                    # codegen merge base
│       ├── .hashes.json               #   COMMIT THIS — one hash per generated path
│       └── <mirrored output>           #   gitignored (a 2nd copy of all output)
└── metaobjects.config.ts              # runtime config
```

File-naming: `meta.<concept>.json`. Each file declares its `package`:

```jsonc
{ "metadata.root": {
    "package": "myapp::commerce",
    "children": [
      { "object.entity": { "name": "Program", ... }},
      { "object.entity": { "name": "Purchase", ... }}
    ]
}}
```

**Optional layered overlay pattern** (for larger projects with team-level concern boundaries):

```
metaobjects/
├── meta.user.json                     # STRUCTURAL (always present)
├── meta.user.ui.json                  # UI overlay (views, layouts) — overlay: true
└── meta.user.db.json                  # DB overlay (sources, dbColumns) — overlay: true
```

All three share the same `package` and object `name`. The Loader merges them. `meta.user.ui.json`
and `meta.user.db.json`'s top-level object declaration must carry `overlay: true`: the loader's
merge doesn't require it (a same-`(type, name)` redeclaration merges either way), but leaving it
off is exactly what `meta verify`'s overlay authoring lint (`docs/features/metadata-dependencies.md`)
flags as advisory — and it's what would turn a renamed/removed `User` into a silent second object
instead of a loud `ERR_OVERLAY_NO_TARGET`. Use only when team-level concerns justify the file
proliferation. Default to single-file-per-domain.

**`BaseEntity` pattern**: shared abstract bases live in `meta.common.json`. Concrete entities use `extends: "BaseEntity"` to inherit `id` + `createdAt` without redeclaring.

## URL prefix policy

`apiPrefix` in `metaobjects.config.ts` is a **server** fact: it is where the generated routes
mount, and codegen bakes it in, because the code that registers `/api/customers` *is* the
server.

```ts
export default defineConfig({
  apiPrefix: "/api",        // generated routes mount under /api
});
```

It does **not** reach the browser. A client's base URL is a DEPLOYMENT fact — one bundle may be
served against a separate API host, a dev proxy, a preview environment or an SSR pass — so it is
supplied at runtime by the provider, not stamped into the entity descriptor:

```tsx
<EntityFetcherProvider fetcher={fetcher} baseUrl="/api">
```

`baseUrl` is optional and defaults to `""`, which is right for the `apiPrefix: ""` scaffold and
a trap for everyone else: omitting it drops the prefix from every generated hook and compiles
clean. `meta verify` advises when `apiPrefix` is non-empty and a provider passes no `baseUrl`.

## Codegen architecture (Vite-style plugins)

`@metaobjectsdev/codegen-ts` follows a Vite-style plugin model: every emitter implements
`Generator`, and generators compose rather than inherit.

🔗 The `Generator` interface, `GenContext`/`EmittedFile` shapes, plugin ordering and the
hand-edit-preserving regeneration rules:
[.claude/rules/codegen-architecture.md](.claude/rules/codegen-architecture.md) (auto-loads on
`packages/**`, `templates/**`, `**/codegen/**`, the codegen conformance fixtures).

## Cross-language porting

Every language port must preserve the metamodel subtype vocabularies, filter operators and
attribute contracts **identically**. The `registry-conformance` gate
(`fixtures/registry-conformance/`) is what proves it — a port is not correct because it compiles,
it is correct because the conformance corpus passes.

🔗 Full vocabulary tables, the retired pre-v2 subtypes, and the per-contract traps:
[.claude/rules/cross-language-porting.md](.claude/rules/cross-language-porting.md) (auto-loads on
`server/{csharp,java,python,typescript}/**`, `client/web/**`, `spec/**`, `fixtures/**conformance**/**`,
`docs/ports/**`). Per-language notes live in [docs/ports/](docs/ports/).

## Design judgment (durable principles)

These are the load-bearing principles that have emerged through implementation. Apply them every time.

- **Expanding the metamodel vocabulary follows ONE decision procedure (ADR-0037) — driven by semantic behavior, not surface storage.** Don't ask "is X a string/number/date?"; ask "what does X *do*?" Ordered test: (0) **derivable** from existing subtype + attrs (`isArray`/`@maxLength`) + structure? → derive in codegen, add nothing; (1) **physical-only** (native type/meaning unchanged)? → the `@dbColumnType` escape hatch, not first-class vocab; (2) logical — **does X have its own native type, behavior, or attributes** (a *thing* that owns custom logic)? → **subtype** (the extension point: `field.uuid`, `field.uri`, `field.inet`); a **structural variant *within* a subtype** (changes generated shape, shares native type)? → **`@kind`** (the one chartered structural-variant axis: source table/view, uri url/urn — never a catch-all, never on a plain string); otherwise X just **modifies/validates/configures** an existing type → **attribute** (boolean flag `@localTime`; validation `@stringFormat` email/hostname; config `@maxLength`). The "string formats" set splits by behavior: url/uri→`field.uri`, ip→`field.inet` (native types + behavior), only email/hostname→`@stringFormat` (plain validated strings); uuid is already `field.uuid`. Self-documentation over economy; no same-name overloads (hence `@stringFormat`, not a third `@format`). Consult it every time. See [ADR-0037](spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md).

- **Pattern-derivable from metadata = codegen, never hand-code.** This is the metaobjects raison d'être. If you find yourself proposing that users hand-write something the metadata fully describes (FK references, basic CRUD, validator chains, type-safe finders, relations() blocks), stop. Codegen it. The only exception is what metadata genuinely cannot express (custom SQL views, regex patterns from outside metadata, business logic). When in doubt, generate.

- **Study reference implementations for subtle pipeline behavior; don't re-derive from spec.** For complex orchestration (loader, parser, super resolution, overlay/override merging, registry lifecycle), the spec describes WHAT but the implementation captures HOW — including edge cases and error handling. When porting, read existing implementations first. First-principles reasoning produces subtly wrong behavior that breaks cross-language interop.

- **"Validated by spike" ≠ "right design".** A spike proves a technique works under a specific test. It doesn't prove it is the best production choice. Always ask "what's the UX cost?" alongside "does this work?"

- **NEVER call `own*()` accessors by default — resolving/effective is the default; `own` breaks `extends` (ADR-0039).** `extends` is a super-*reference*, not a flatten: inherited attrs/children live on the parent, reachable only via the *resolving* accessors (`attr()`/`children()`/`getMetaAttr(name)` / Python `attrs().get()`). Reading a field/node's effective property (`isArray`, `subType`, `@maxLength`, `@precision`, `@default`, `@column`, `@objectRef`, `@storage`, …) or iterating its member set through an **own-only** accessor (`ownAttr`/`ownChildren`/`ownFields`/`field.isArray` native flag / Java `,false`) silently drops everything inherited via `extends` — corrupting codegen and runtime. The **one** legitimate `own*()` use: **codegen emitting a generated subclass, iterating `ownFields()` so inherited members aren't re-emitted** (the generated base already has them). The metamodel-internal siblings (own-mode canonical serializer, overlay-merge, super-resolution walks) use the same "emit only the declared-here layer" principle. The one attr deliberately own-only is `@dbColumnType` (physical, never inherited). Every `own*()` call must carry a comment naming its sanctioned case; any other own read is a bug. Watch the naming inversion: Python `attr()` is OWN, TS `attr()` resolves. See [ADR-0039](spec/decisions/ADR-0039-own-accessor-discipline.md).

- **Bind metadata→native types at build time, never runtime reflection.** Resolving an object's native class/module from its FQN must happen in generated code (static imports for data-oriented ports; a domain-sliced, FQN-keyed registry for OO ports), not via `Class.forName`/`Type.GetType`/`importlib` — runtime reflection is impossible in TS and breaks under GraalVM native-image / .NET AOT. See [ADR-0001](spec/decisions/ADR-0001-cross-language-type-binding.md).

- **Record significant cross-cutting decisions as ADRs.** Durable, cross-language/cross-feature architectural contracts live in `spec/decisions/` (Nygard format). Consult them before changing a cross-language contract; add a new ADR when you make one. Feature-level decisions stay in the FR spec; this file holds only the one-line rule + the pointer.

- **Strict metadata provenance — never invent a metamodel attribute (ADR-0023).** Every type/subtype/attribute the loader accepts in THIS repo must come from a registered metamodel provider; the library boots strict + seals the registry after the defined-provider bootstrap, so any undeclared attr is `ERR_UNKNOWN_ATTR` and any post-bootstrap registration is `ERR_REGISTRY_SEALED` (codegen "making up" an attr is a hard build failure). Before adding ANY new metamodel attribute: (1) prove it **cannot be computed** from existing metadata — if a generator can derive it (FK refs, column types, validator chains, naming), derive it, don't add an attr; (2) get **explicit human agreement** and write the can't-be-computed justification into the FR spec / ADR; (3) add it to a registered provider AND a `registry-conformance` fixture so all five ports gate it. Downstream apps may add their own providers or loosen strictness — but the library's tests never permit an unregistered attr. See [ADR-0023](spec/decisions/ADR-0023-strict-metadata-provenance.md). The legitimate escape hatch for arbitrary author-supplied properties is the registered `attr.properties` bag (exempt from the strict-attr check), not a new first-class attr.

## Coding discipline (TS)

- **Named constants for metamodel strings — always.** Type names, subtype names, reserved JSON keys, special attribute names, structural separators, and wildcards live in per-concern `*-constants.ts` modules under `packages/metadata/src/`, barreled into the browser-safe `@metaobjectsdev/metadata/constants` entry — import from there and use them. Gets you compile-time typo safety. (This rule used to name a single `packages/metadata/src/constants.ts`; that file holds no constants and has not for some time.)
- **Use `as const` arrays + type unions** for closed sets (e.g., `FIELD_SUBTYPES = [...] as const; type FieldSubType = (typeof FIELD_SUBTYPES)[number]`).
- **String literals OK only for**: error message text, instance/entity names that are user data, and test data values that aren't metamodel-level concepts.
- **No backwards-compat hacks.**
- **No `any` escape hatches.** Use `unknown` and narrow.
- **Never `instanceof` a metadata node from another package.** Cross-package code (`codegen-ts`, `migrate-ts`, `runtime-ts`, `cli`) identifies nodes with the guards `@metaobjectsdev/metadata` exports — `isMetaRoot` / `isMetaObject` / `isMetaField` / `isMetaSource` / `isWritableSource` / `isReadOnlySource` — never `x instanceof MetaSource`. Two physical copies of the package in one process (a globally-installed or linked `meta` CLI plus a project-local dependency) give the class object and the instance different identities, so `instanceof` returns **false for a real node**. The failure is **silent**: in `codegen-ts` the entity reads as "not backed by any store" and simply emits no table/queries/routes; in `migrate-ts` it drops the table from the EXPECTED schema, so `meta migrate` proposes `DROP TABLE` against a live database. This is the same class-identity defect that split ts-poet's `Code` objects in 0.21.6. The CLI's alias map (`load-metaobjects-config.ts` `CLI_PKG_PATHS`) closes it for `meta gen`/`migrate` **only** — a consumer embedding `runGen()` or the migrate engine programmatically never runs it. Sites **inside** `metadata` are immune by construction (a package's own module graph resolves its own files) and keep using `instanceof`. Mechanism + blast radius: `metadata/src/shared/node-guards.ts`.

## Useful commands

```
meta init                             # scaffold metaobjects/, .metaobjects/, codegen/generators/, metaobjects.config.ts, .gitignore
meta gen [<entity>...]                # codegen: render templates → format → three-way merge → write
meta gen --dry-run                    # preview without writing
meta eject <generator> [--list]       # copy a reference generator into the repo to own (FR-040)
meta migrate                          # diff metadata vs DB schema; emit migration SQL
meta migrate --dry-run                # preview without writing migration file
meta migrate apply-pending            # replay the committed chain against --db (no diff, no metadata)
meta verify --codegen --docs --templates   # drift gates: generated code, docs pages, prompt bodies
meta verify --db | --replay           # schema drift vs a live DB | the chain applies to an empty one
meta docs [--agent]                   # neutral model/api pages; --agent writes the three agent/ pages
meta upgrade --apply                  # rewrite metadata a retirement made illegal
meta types [<type>] --format json|toon # what vocabulary this build actually registers
```

The above is the **Node `meta`** (schema + TS codegen). Each non-TS port runs
codegen through its own build tool — `dotnet meta gen`/`verify` (C#),
`mvn metaobjects:generate`/`:verify` (Java/Kotlin), `metaobjects gen`/`verify`
(Python). Schema (`migrate`, `verify --db`) is Node-`meta`-only. Full matrix +
rationale: [docs/features/cli.md](docs/features/cli.md) (locked CLI architecture,
ADR-0015).

## Running tests

The Bun workspace root is the **repository root** (`/package.json`), which globs `server/typescript/packages/*` and `client/web/packages/*`. Java/Python/C# live outside the JS workspace (not globbed). Run `bun install` **once at the repo root**. Run `bun test` **scoped** — `cd server/typescript && bun test` for the server suite (this also picks up `server/typescript/bunfig.toml`'s test preload), and per-package for `client/web`. **Never run a bare `bun test` at the repo root**: it walks `java/`, `python/`, `csharp/`, and `fixtures/` looking for test files, turning a fast per-package run into many minutes.

```
bun install                                        # once, at the repo root
cd server/typescript && bun test                   # server suite (per-package; a bare run over the whole server suite now exceeds 5 min — scope it)
cd client/web/packages/<pkg> && bun test           # a single client package
bun run --filter '*' typecheck                     # whole workspace, from repo root
bun run --filter '*' build                         # whole workspace, from repo root
```

## How to contribute

PRs welcome. When contributing:

- Follow the TDD discipline: write tests first, then implementation.
- Use named constants for all metamodel strings — never inline `"field"`, `"object"`, etc.
- No `any` — use `unknown` and narrow.
- Run `bun test` in the relevant package before opening a PR. All tests must pass.
- For cross-language changes, ensure the wire format and vocabulary are preserved exactly.
- Look at existing generator implementations before adding a new one — the pattern is intentionally consistent.

For significant new features or architectural changes, open an issue first to discuss the approach.

**Publishing:** To iterate an unreleased change against a downstream project, use [docs/features/prerelease.md](docs/features/prerelease.md) — publish to the private registry (`bun run prerelease:publish`), consume it, iterate, and revert with one verified command. For full public releases, see [docs/RELEASING.md](docs/RELEASING.md) — the procedure (RC → smoke-test → promote) plus the non-obvious gotchas (publish with `bun`, regen the lockfile after every version bump, runtime imports must be `dependencies`, verify a real external install in npm *and* pnpm).

**Never hardcode the npm publish set.** `scripts/publish-set.mjs` is the single source of
truth for WHICH `@metaobjectsdev/*` packages a release publishes and in WHAT ORDER; both
publish paths — `scripts/release.mjs` and `.github/workflows/publish-npm.yml` — read it, and
a new publish path must too. They used to answer the question separately (one derived, one
listed 13 directories) and drifted: `@metaobjectsdev/docs-site` is a runtime dependency of
`@metaobjectsdev/cli` and was missing from the workflow's list, so a release cut there would
have shipped a `cli` pinning a version nobody published. The derivation throws on an
untiered member, an inverted tier order, or a set not closed over its own sibling deps —
adding a package to the lockstep set is one explicit `TIER_ORDER` decision, because an
omission does NOT sort last (`indexOf() === -1` sorts it **first**, ahead of its own
dependencies). Gated in the `gates` lane as `publish-set parity`, beside
`check-publish-intent.sh` — which enforces the same rule from the other side (a non-private
package off the lockstep line must be declared source-only).

## Roadmap pointer

See `spec/roadmap.md` for current and planned library work. (Consumer-adoption validation and the application-level prompt-pillar consolidation are pursued in adopter projects, not tracked in this repo.)

## Open questions

- [TECHNICAL] Field-type → Drizzle-column-type mapping table (needed for complete TS codegen coverage).

**Closed, recorded so they are not re-proposed.** *jOOQ for OMDB* — its OSS edition excludes
Oracle / SQL Server / DB2 (commercial licence required), which would paywall OMDB's
commercial-DB drivers in a public OSS project, and jOOQ generates code *from* a schema, the
inverse of metadata-is-the-spine. *OMDB engine debt* — FR-003 Plan 4 closed the three
anti-patterns; the Spring Boot 3 starter and OMDB autoconfiguration shipped. *WARN
envelope-shape on `expected-warnings.json`* — every runner asserts it; the legacy string-list
path is retired.
