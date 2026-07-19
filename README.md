# MetaObjects

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
- Want the cross-language contract? → [`fixtures/`](fixtures/) (the conformance corpora are the oracle).

## Languages

| Language | Status | Quickstart | Source |
|---|---|---|---|
| TypeScript | Published to npm at `0.19.0` (the `@metaobjectsdev/*` packages) | [`docs/ports/typescript.md`](docs/ports/typescript.md) | [`server/typescript/`](server/typescript/) · [`client/web/`](client/web/) |
| Java | Loader + OMDB + render + Maven plugin all shipped; full conformance green | [`docs/ports/java.md`](docs/ports/java.md) | [`server/java/`](server/java/) |
| Kotlin | Codegen tier on top of Java — 7 generators (entity, Exposed table, relations, payload, validator, Spring config, storedProc); 12 / 12 persistence-conformance | [`docs/ports/kotlin.md`](docs/ports/kotlin.md) | [`server/java/codegen-kotlin/`](server/java/codegen-kotlin/) · [`server/java/metadata-ktx/`](server/java/metadata-ktx/) |
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
| Payload-VO codegen | Yes (via projection) | – (consumers use `Map`) | Yes (`@Serializable`) | Yes | – (consumers use `dict`) |
| Migration emission | `meta migrate` (Postgres / SQLite / D1) | Via TS toolchain (`@metaobjectsdev/cli migrate`) | Via TS toolchain (`@metaobjectsdev/cli migrate`) | Via TS toolchain (ADR-0015) | Via TS toolchain (ADR-0015) |
| DB-drift verify | `meta verify --db` | Template-drift: `Renderer.verify`; schema-drift is TS-owned (ADR-0015) | Template-drift: `Renderer.verify`; startup: `MetadataStartupValidator` | `dotnet meta verify` (codegen-drift) | Schema-drift is TS-owned (ADR-0015) |
| Template-drift verify | Yes | Yes (`Renderer.verify`) | Yes (via Java) | Yes (`meta verify`) | Yes (`metaobjects.render.verify`) |
| YAML authoring (sigil-free → JSON) | Yes | Yes | Yes (via Java) | Yes | Yes |
| Runtime metadata (ObjectManager-style) | Yes (`runtime-ts`) | Yes (OMDB) | Yes (via Java OMDB + Exposed) | Roadmap | Yes (ObjectManager) |
| React / UI client (browser) | Yes (`@metaobjectsdev/react` + `@metaobjectsdev/tanstack`; codegen + runtime) | Consumes TS client via REST | Consumes TS client via REST | Consumes TS client via REST | Consumes TS client via REST |
| Cross-port REST routes for the client | Generated (`routesFile()` → Fastify) | Hand-write Spring controller per contract | Hand-write Spring-Kotlin / Ktor per contract | Generated (`RoutesGenerator` → ASP.NET Minimal API) | Hand-write FastAPI router per contract |

A "Yes" means the feature is covered by the shared conformance corpora at
[`fixtures/`](fixtures/) for that port, or by a port-local test of equivalent
scope. A "partial" means the loader recognizes the metamodel feature but the
codegen / runtime tier doesn't fully exercise it yet.

The React / UI client is TypeScript-only by construction (the browser is
TS-native) but is **universal** — see
[`docs/features/api-contract.md`](docs/features/api-contract.md) for the
URL grammar + wire format the client speaks, and
[`docs/ports/typescript-client.md`](docs/ports/typescript-client.md) for
the consumer-side wiring.

## Four pillars

All four ship per-language today — but they are not uniformly deep. See the
[capability matrix](#capability-matrix) for per-port coverage; in field
materialization the ranking is **drift > codegen > prompts > runtime metadata**
(the youngest pillar). The prompt pillar's library-side building blocks are
complete in all five ports; MCP exposure of declared prompts/tools is the one
remaining roadmap item:

1. **Codegen** — emit idiomatic per-language code (Drizzle/Zod + Fastify for TS,
   POJO + OMDB for Java, `data class` + Exposed for Kotlin, EF Core
   record + ASP.NET routes for C#, `@dataclass` for Python). Hand-edit-preserving
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
├── fixtures/                       # cross-language conformance corpora
│   ├── conformance/                # metamodel (loader + serializer + navigation)
│   ├── yaml-conformance/           # YAML authoring desugar
│   ├── render-conformance/         # FR-004 byte-identical render oracle
│   ├── verify-conformance/         # FR-004 template-drift gate
│   └── persistence-conformance/    # on-demand integration tests vs real Postgres
├── docs/
│   ├── README.md                   # docs index
│   ├── features/                   # feature reference (one file per metamodel feature)
│   ├── ports/                      # per-port quickstarts
│   ├── recipes/                    # deployment recipes (Cloudflare D1, …)
│   ├── superpowers/specs/          # design specs
│   └── RELEASING.md                # npm publish procedure
│
├── server/                         # runs on a server
│   ├── typescript/                 # the reference port
│   ├── java/                       # Java port (incl. codegen-kotlin + metadata-ktx)
│   ├── csharp/                     # C# port
│   └── python/                     # Python port
│
└── client/
    └── web/                        # universal browser packages (React, TanStack, framework-agnostic)
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
scripts/integration-test.sh            # all runners (ts + csharp + java + python)
scripts/integration-test.sh ts         # just TypeScript
scripts/integration-test.sh csharp     # just C#
scripts/integration-test.sh java       # just Java
scripts/integration-test.sh python     # just Python
# Kotlin runs via Maven directly (not yet wired into the script):
cd server/java && mvn -pl integration-tests-kotlin test
```

The persistence corpus + the cross-port test harness are the contract: identical
normalized results across every port, or it's a port bug. See
[`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) for the per-corpus + per-port pass status.

## How to contribute

PRs welcome. Read [`CLAUDE.md`](CLAUDE.md) for the project conventions (TDD
discipline, named-constants-for-metamodel-strings, no-`any` rule, cross-language
porting contract). For significant new features, open an issue first to discuss
the approach.

## Roadmap

[`spec/roadmap.md`](spec/roadmap.md) for current + planned work.

## Releasing

[`docs/RELEASING.md`](docs/RELEASING.md) for the npm publish procedure
(RC → smoke-test → promote).

## License

Apache 2.0 ([LICENSE](LICENSE)).
