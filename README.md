# MetaObjects

[![npm](https://img.shields.io/npm/v/%40metaobjectsdev%2Fcli?label=npm%20%40metaobjectsdev%2Fcli)](https://www.npmjs.com/package/@metaobjectsdev/cli)
[![Maven Central](https://img.shields.io/maven-central/v/com.metaobjects/metaobjects-metadata?label=maven%20central)](https://central.sonatype.com/artifact/com.metaobjects/metaobjects-metadata)
[![PyPI](https://img.shields.io/pypi/v/metaobjects?label=pypi)](https://pypi.org/project/metaobjects/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A **cross-language metadata standard** for declaring typed entity models that
drive code generation, runtime metadata access, drift detection, and prompt
construction — across TypeScript, Java, Kotlin, C#, and Python.

The metamodel is the **durable spine**; generated code is the **disposable
artifact**. Substrate is local-first: typed metadata lives in your repo, and the
generated code is idiomatic per-language output with **no proprietary runtime** —
the entity/model tier is dependency-free, and the optional client, prompt-render,
and runtime tiers are ordinary Apache-2.0 packages you could vendor or fork. If
the package ecosystem disappears tomorrow, you keep working code.

> **Maintainer note.** MetaObjects is primarily a one-person, part-time project.
> Issues and PRs are very welcome — expect responses on the order of days, not
> hours. The metadata-driven *approach* has run in production for 20+ years; the
> unified five-language *standard* in this repo is new and launching now. And by
> design you are never blocked on the maintainer: the generated code carries no
> proprietary runtime (see above), so you are never locked in.

> **Built AI-first, verified by construction.** This standard is developed with heavy
> AI assistance under a disciplined review-and-verify process — nothing ships that
> can't be explained. Breadth across five language ports is a deliberate choice, and
> the architecture is what makes it safe: a single metadata spine, a cross-language
> conformance corpus that byte-checks every port ([`fixtures/`](fixtures/)), and drift
> that breaks the build. The same mechanism that keeps *your* AI-generated code
> coherent is the one that keeps this codebase honest.

## Try it on your repo — nothing to install

MetaObjects ships a hosted **fit & migration assessment**: one Markdown prompt your
coding agent runs against your existing repo. It is **read-only and propose-only** —
it installs nothing, edits nothing, and needs no database connection and no signup.
Your agent reads the code, the migrations, and the git history, then writes a
decision-grade report
(`metaobjects-fit/fit-assessment.md` plus a machine-readable JSON twin).

The centerpiece is a **drift ledger built from your own history**: every shape your
repo declares more than once, whether the copies disagree *today*, the past commits
where a fix patched one copy and missed the other — and, per finding, the `verify`
gate that would have made it a build failure instead of an incident. In a blinded
retro-test on a real pre-adoption production codebase, the assessment surfaced
specific, git-verified drift incidents that had already bitten — including a
CHECK-constraint mismatch repaired only after a production violation, and a schema
divergence still live at assessment time — and its misses ran conservative, not
inflated ([design + retro-test](docs/superpowers/specs/2026-07-12-metaobjects-fit-assessment-design.md)).

With your repo open in your coding agent (Claude Code, Cursor, Windsurf, GitHub
Copilot, Gemini CLI, Codex — anything that can fetch a URL), send one message:

```text
Fetch https://metaobjects.dev/assess.md and run the MetaObjects Fit & Migration
Assessment against this repository.
```

If your agent can't fetch URLs (or you want it to follow the prompt verbatim), save
the file into your workspace instead — `curl -fsSL https://metaobjects.dev/assess.md
-o metaobjects-assess.md` (don't commit it) — and say: *"Read
`metaobjects-assess.md` and run the assessment it contains against this
repository."* The prompt is one Markdown file
([source](agent-context/skills/metaobjects-fit-assessment/SKILL.md)); read it first
if you like — you should never point your agent at a prompt you haven't vetted.

The catch, stated plainly: it runs in **your** agent on **your** tokens (minutes of
agent time, none of yours); findings vary by model and repo size; and every claim is
cited to a `file:line` or a commit precisely so you can check it. Nothing is sent to
us — there is no signup, and the report stays in your repo.

The report is built to say **no**: per-pillar verdicts include `NOT A FIT`, every
capability claim is capped to what your language's port actually ships, and a
"what you will NOT get" section is mandatory. If the verdict is yes, it ends with a
first-week wedge plan — and `meta init` picks up from there.

## Quick links

- Already have a codebase? → Have your coding agent run the
  [fit assessment](#try-it-on-your-repo--nothing-to-install) — read-only, no
  install; it finds the drift already in your git history.
- New here? Pick your language → [`docs/ports/`](docs/ports/) (TS / Java / Kotlin / C# / Python).
- Want the metamodel feature reference? → [`docs/features/`](docs/features/).
- Want the documentation index? → [`docs/README.md`](docs/README.md).
- Want the design rationale? → [`spec/`](spec/) + [`docs/superpowers/specs/`](docs/superpowers/specs/).
- Want a worked, non-toy model? → [`examples/advanced-modeling/`](examples/advanced-modeling/)
  (projections, value objects, TPH, prompt payloads on one runnable spine).
- Want the cross-language contract? → [`fixtures/`](fixtures/) (the conformance corpora are the oracle).

## Languages

| Language | Status | Quickstart | Source |
|---|---|---|---|
| TypeScript | Published to npm at `0.21.5` (the `@metaobjectsdev/*` packages) | [`docs/ports/typescript.md`](docs/ports/typescript.md) | [`server/typescript/`](server/typescript/) · [`client/web/`](client/web/) |
| Java | Loader + OMDB + render + Maven plugin all shipped; full conformance green | [`docs/ports/java.md`](docs/ports/java.md) | [`server/java/`](server/java/) |
| Kotlin | Codegen tier on top of Java — 14 generators (entity, Exposed table, relations, repository, payload, output-parser, output-prompt, render-helper, extractor, filter-allowlist, validator, Spring config, storedProc, Spring controller); 24 / 24 persistence-conformance | [`docs/ports/kotlin.md`](docs/ports/kotlin.md) | [`server/java/codegen-kotlin/`](server/java/codegen-kotlin/) · [`server/java/metadata-ktx/`](server/java/metadata-ktx/) |
| C# | Loader + conformance + EF Core codegen + render engine + `dotnet meta` CLI all shipped | [`docs/ports/csharp.md`](docs/ports/csharp.md) | [`server/csharp/`](server/csharp/) |
| Python | Loader + conformance + render + entity-model codegen + ObjectManager runtime shipped; schema migrations are TS-owned (ADR-0015) | [`docs/ports/python.md`](docs/ports/python.md) | [`server/python/`](server/python/) |

## Capability matrix

| Feature | TS | Java | Kotlin | C# | Python |
|---|---|---|---|---|---|
| Entities + fields | Yes | Yes | Yes | Yes | Yes |
| Relationships + FK | Yes | Yes | Yes | Yes | Loader yes; codegen partial |
| Source kinds (`table` / `view`) | Yes | Yes | Yes | Yes | Loader yes; codegen partial |
| Source kinds (`storedProc` / `tableFunction` / `materializedView`) | Yes | Yes | Yes (storedProc generator) | Partial | Loader yes; codegen partial |
| `field.currency` / `field.enum` | Yes | Yes | Yes | Yes | Yes |
| `field.object` + `@storage=flattened` | Yes | Yes | Yes (per-sub-field columns) | Yes (EF Core `OwnsOne`) | Loader yes; codegen partial |
| Templates + render (FR-004) | Yes | Yes | Yes (wraps Java) | Yes | Yes |
| Payload-VO codegen | Yes (via projection) | Yes (`SpringPayloadGenerator`) | Yes (`@Serializable`) | Yes | Yes (`payload_vo_generator`) |
| Migration emission | `meta migrate` (Postgres / SQLite / D1) | Via TS toolchain (`@metaobjectsdev/cli migrate`) | Via TS toolchain (`@metaobjectsdev/cli migrate`) | Via TS toolchain (ADR-0015) | Via TS toolchain (ADR-0015) |
| DB-drift verify | `meta verify --db` | Template-drift: `Verify.check`; schema-drift is TS-owned (ADR-0015) | Template-drift: `Verify.check`; startup: `MetadataStartupValidator` | `dotnet meta verify` (codegen-drift) | Schema-drift is TS-owned (ADR-0015) |
| Template-drift verify | Yes | Yes (`Verify.check`) | Yes (via Java) | Yes (`dotnet meta verify`) | Yes (`metaobjects.render.verify`) |
| YAML authoring (sigil-free → JSON) | Yes | Yes | Yes (via Java) | Yes | Yes |
| Runtime metadata (ObjectManager-style) | Yes (`runtime-ts`) | Yes (OMDB) | Yes (via Java OMDB + Exposed) | Roadmap | Yes (ObjectManager) |
| React / Angular UI client (browser) | React: **published** (`@metaobjectsdev/react` + `@metaobjectsdev/tanstack`), codegen + runtime. Angular 18: **source-only by decision** ([ADR-0047](spec/decisions/ADR-0047-angular-tier-source-only.md)) — `@metaobjectsdev/angular` + `@metaobjectsdev/codegen-ts-angular` build in-repo on their own `0.6.x` line but are deliberately not on npm (`npm i @metaobjectsdev/angular` will 404) until they meet the ADR's promotion bar. Consume them from source. | Consumes TS client via REST | Consumes TS client via REST | Consumes TS client via REST | Consumes TS client via REST |
| Cross-port REST routes for the client | Generated (`routesFile()` → Fastify) | Generated (`SpringControllerGenerator` → Spring `@RestController`, incl. filter/sort) | Generated (`KotlinSpringControllerGenerator` → Spring `@RestController`, incl. filter/sort) | Generated (`RoutesGenerator` → ASP.NET Minimal API) | Generated (`router_generator` → FastAPI `APIRouter`, incl. filter/sort) |

A "Yes" means the feature is covered by the shared conformance corpora at
[`fixtures/`](fixtures/) for that port, or by a port-local test of equivalent
scope. A "partial" means the loader recognizes the metamodel feature but the
codegen / runtime tier doesn't fully exercise it yet.

The React and Angular UI clients are TypeScript-only by construction (the
browser is TS-native) but are **universal** — see
[`docs/features/api-contract.md`](docs/features/api-contract.md) for the
URL grammar + wire format the client speaks, and
[`docs/ports/typescript-client.md`](docs/ports/typescript-client.md) for
the consumer-side wiring (React + TanStack, and the
[Angular 18 tier](docs/ports/typescript-client.md#angular-18)).

## Four pillars

All four ship per-language today — but they are not uniformly deep. See the
[capability matrix](#capability-matrix) for per-port coverage; in field
materialization the ranking is **drift > codegen > prompts > runtime metadata**
(the youngest pillar). The prompt pillar's library-side building blocks are
complete in all five ports; MCP exposure of declared prompts/tools is the one
remaining roadmap item:

1. **Codegen** — emit idiomatic per-language code (Drizzle/Zod + Fastify for TS,
   Spring REST + DTO + repository for Java, `data class` + Exposed for Kotlin, EF Core
   record + ASP.NET routes for C#, Pydantic + FastAPI for Python). Hand-edit-preserving
   regen via three-way merge.
2. **Runtime metadata** — load metadata at runtime, drive behavior dynamically
   (CRUD, validation, relationships, dynamic admin UIs; typed tool payloads are
   declared today, with MCP exposure on the roadmap).
3. **Drift detection** — catch divergence across the 7 drift sources (code/DB,
   code/API-doc, DB/metadata, migration/metadata, generated-edited, prompt/payload,
   generated/runtime). See [`docs/features/migrations-and-drift.md`](docs/features/migrations-and-drift.md).
4. **Prompt construction** *(library-side pieces shipped in all five ports; MCP exposure on the roadmap)* — the prompt
   is code too. Declare a prompt's payload as a typed projection (payload bloat
   becomes a diff), keep its text external and provider-resolved, render it
   deterministically (snapshot-testable, cache-stable, drift-checked at build
   time, conformance-gated cross-language). See
   [`docs/features/templates-and-payloads.md`](docs/features/templates-and-payloads.md).

## Repo layout

```
metaobjects/
├── README.md                       # you are here
├── CLAUDE.md                       # project instructions for Claude
├── spec/                           # canonical metamodel docs, ADRs, roadmap
├── fixtures/                       # 19 cross-language conformance corpora — the oracle
│   ├── conformance/                # metamodel (loader + serializer + navigation), 270 fixtures
│   ├── yaml-conformance/           # YAML authoring desugar
│   ├── render-conformance/         # FR-004 byte-identical render oracle
│   ├── verify-conformance/         # FR-004 template-drift gate
│   ├── extract-conformance/        # FR-010 tolerant output parsing
│   ├── api-contract-conformance/   # the REST wire contract, reference + generated lanes
│   ├── persistence-conformance/    # on-demand integration tests vs real Postgres
│   └── …                           # registry, validation, codegen, provider-composition, …
│                                   #   full matrix: docs/CONFORMANCE.md
├── docs/
│   ├── README.md                   # docs index
│   ├── features/                   # feature reference (one file per metamodel feature)
│   ├── ports/                      # per-port quickstarts
│   ├── recipes/                    # deployment recipes (Cloudflare D1, …)
│   ├── CONFORMANCE.md              # corpus × port matrix + fixture→feature index
│   ├── superpowers/specs/          # design specs
│   └── RELEASING.md                # npm publish procedure
├── examples/
│   └── advanced-modeling/          # a worked, runnable non-toy model
├── library/                        # shipped standard-library metadata, opt-in per project
│   └── ai/                         #   via `libraries: ["ai"]` (e.g. the LLM-call trace base)
├── templates/                      # canonical api/docs Mustache templates (the SSOT the
│                                   #   ports embed; byte-gated so copies cannot drift)
├── agent-context/                  # the shared source the per-port AI-assistant context
│                                   #   surfaces are generated from (AGENTS.md, skills, llms.txt)
├── scripts/                        # CI parity (`ci-local.sh`), codegen of embedded assets, one-offs
│
├── server/                         # runs on a server
│   ├── typescript/                 # the reference port
│   ├── java/                       # Java port (incl. codegen-kotlin + metadata-ktx)
│   ├── csharp/                     # C# port
│   └── python/                     # Python port
│
└── client/
    └── web/                        # universal browser packages (React, TanStack, Angular, framework-agnostic)
```

## Getting started

| Language | First command |
|---|---|
| TypeScript | `npm i @metaobjectsdev/cli && npx meta init` → [`docs/ports/typescript.md`](docs/ports/typescript.md) |
| Java | Add `metaobjects-maven-plugin` to your `pom.xml` → [`docs/ports/java.md`](docs/ports/java.md) |
| Kotlin | Add `metaobjects-codegen-kotlin` + `metaobjects-metadata-ktx` → [`docs/ports/kotlin.md`](docs/ports/kotlin.md) |
| C# | `dotnet tool install --global MetaObjects.Cli` → [`docs/ports/csharp.md`](docs/ports/csharp.md) |
| Python | `pip install metaobjects` → [`docs/ports/python.md`](docs/ports/python.md) |

## Cross-language conformance

Every port runs against the same fixture corpora at [`fixtures/`](fixtures/).
Per-port unit tests stay container-free; the on-demand integration suite spins up
ephemeral Postgres containers and exercises every shipped port's persistence
layer against the shared scenario corpus:

```bash
scripts/integration-test.sh            # all runners (ts + csharp + java + python + kotlin)
scripts/integration-test.sh ts         # just TypeScript
scripts/integration-test.sh csharp     # just C#
scripts/integration-test.sh java       # just Java
scripts/integration-test.sh python     # just Python
scripts/integration-test.sh kotlin     # just Kotlin
```

The persistence corpus + the cross-port test harness are the contract: identical
normalized results across every port, or it's a port bug. See
[`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) for the per-corpus + per-port pass status.

## How to contribute

PRs welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to propose a
change and the project conventions it has to meet (TDD discipline,
named-constants-for-metamodel-strings, no-`any` rule, cross-language porting
contract, public-repo hygiene). For significant new features, open an issue
first to discuss the approach.

## Roadmap

[`spec/roadmap.md`](spec/roadmap.md) for current + planned work.

## Releasing

[`docs/RELEASING.md`](docs/RELEASING.md) for the npm publish procedure
(RC → smoke-test → promote).

## License

Apache 2.0 ([LICENSE](LICENSE)).
