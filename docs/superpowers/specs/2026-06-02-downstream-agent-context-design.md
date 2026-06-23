# Downstream agent context — design

**Date:** 2026-06-02
**Status:** Design (pending review)
**Relates to:**
- The existing `meta init` agent-docs scaffolding (`server/typescript/packages/sdk/src/agent-docs/body.ts`).
- `2026-06-02-neutral-metadata-docs-design.md` — *complementary, not overlapping*: that work generates language-neutral documentation **of the adopter's own metadata model** (entity/`template.output` pages, output of `meta gen`). **This** work delivers context that teaches an adopter's **AI assistant how to use MetaObjects itself**. Different files, different purpose; both happen to emit Markdown.

## Goal

Give downstream apps that adopt MetaObjects (across all five ports) authoritative,
version-matched context so their AI assistant — Claude Code first, but any
agent/IDE second — knows how to **author metadata, run codegen, wire runtime/UI,
and verify**, without bloating always-on memory and without drifting from the
library.

Deliver that context from **one shared source** through **three thin surfaces**:

1. **Portable always-on Markdown** scaffolded into the consumer project
   (`.metaobjects/AGENTS.md` + `.metaobjects/CLAUDE.md`) — read by any agent.
2. **Claude Code skills** scaffolded into the consumer project
   (`.claude/skills/metaobjects-*/`) — model-invoked, on-demand depth.
3. **Website `llms.txt` / `llms-full.txt`** (the `metaobjects.dev` repo) — the
   *pre-install discovery surface* that tells an assistant to install the package
   and run the init command, which scaffolds (1) and (2).

All five ports deliver equivalent context; a conformance corpus gates it.

## Non-goals

- **Not** building the Claude Code plugin/marketplace now. It is a clean later
  phase (P4) once the skills stabilize; the npm/Maven/pip/dotnet scaffolder is the
  primary distribution per the chosen direction ("scaffolder now, plugin later").
- **Not** hijacking the consumer's own root `CLAUDE.md`/`AGENTS.md`. We scaffold a
  *separate* importable file and *offer* (opt-in, never clobber) to add one import
  line.
- **Not** per-port hand-maintained content. The content is authored once; ports
  add only thin overlays + a delivery command.
- **Not** a universal `npx` scaffolder for non-TS shops (noted as a possible later
  convenience; each port ships its own native command instead).
- **Not** documenting the adopter's *own* entities — that is the neutral-metadata-docs
  work above.

## Research basis

Grounded in current (2026) Claude Code guidance
([skills](https://code.claude.com/docs/en/skills),
[skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices),
[CLAUDE.md memory](https://code.claude.com/docs/en/memory.md),
[plugins](https://code.claude.com/docs/en/plugins.md)):

- **Skills are triggered entirely by their `description`** and load on demand
  (only name+description are pre-loaded). Body ≤ ~500 lines; deeper material goes
  in bundled reference files (progressive disclosure). A vague description means
  the skill never fires.
- **`CLAUDE.md` is loaded every turn** — keep it tiny; only what applies broadly.
  Conditionally-relevant procedure → a skill, not memory.
- **npm-style scaffolder is idiomatic** for shipping skills to a consumer project
  (copy into `.claude/`), mirroring how dev tooling ships config/hooks. A
  plugin + marketplace is the heavier, versioned alternative.
- **Skills are namespaced** (`/superpowers:brainstorming` vs
  `/metaobjects:authoring`) → no collision with the `superpowers` plugin. A library
  skill may *reference* superpowers but must **not hard-depend** on it (consumers
  may not have it); reference optionally with a fallback.
- **Downstream apps do not have the repo's `docs/` folder** → every scaffolded
  artifact must be **self-contained** (bundle its reference content) or link to the
  docs *site*.
- **`llms.txt`** is the established pre-install convention; `metaobjects.dev`
  already ships one.

## Current state

- `meta init` already scaffolds `.metaobjects/AGENTS.md` + `.metaobjects/CLAUDE.md`
  (same ~300-line body from `sdk/src/agent-docs/body.ts`), content-hash tracked,
  refreshable via `meta init --refresh-docs`. This is the seed to evolve — today it
  is **one always-on blob** with no skills and no on-demand layering.
- Rich repo corpus exists but is repo-only (not shipped to consumers):
  `docs/features/*`, `docs/ports/*`, `spec/*`, per-package READMEs.
- Website `metaobjects.dev` ships `www/llms.txt` (curated index — already mentions
  `meta init` but only as "scaffold dirs + config", not as the AI bootstrap step)
  and `www/llms-full.txt` (**stale**: still says prompt construction is "landing in
  7.0.0", "C# codegen out of scope", "jOOQ" for Java). `metaobjects.com` is the
  separate commercial site and is **not** in scope.

## Architecture

One shared source of truth → many thin per-port deliveries → conformance-gated.

```
MONOREPO  agent-context/  ← single AI-facing source (universal core + tooling + per-language fragments + skill bodies)
   │            │
   │            ├──► assemble → llms.txt + llms-full.txt (canonical, version-pinned)
   │            │                     └─ consumed/copied by → metaobjects.dev repo (REMOTE pre-install)
   │            │
   │            └──► packaged into each port artifact (cli / maven-plugin / pip pkg / dotnet tool)
   │                       └─ scaffolded on the port's init command into the consumer project:
   │
   └──► consumer project:  .metaobjects/AGENTS.md + .metaobjects/CLAUDE.md   (always-on, portable)
                           .claude/skills/metaobjects-*/SKILL.md             (Claude, on-demand)
```

**Two-stage adoption flow:** an assistant asked "help me adopt MetaObjects" fetches
`metaobjects.dev/llms.txt` → it says *install the port's package and run the init
command* → init scaffolds the **version-matched** local `AGENTS.md` + skills the
assistant then uses. `llms.txt` stays a concise pointer; the deep how-to lives in
the scaffolded context (matching the site's "signpost, not encyclopedia"
philosophy).

## Layering & context optimization

The content must not put every language in one file — a polyglot project should
carry only what it uses, and an assistant should load language detail only when a
task needs it. Variation collapses to **four axes** (the client side is always
TypeScript — the browser is TS-native; a Java or Python backend serving React still
uses the `@metaobjectsdev/react`/`tanstack` packages):

| Axis | Values | Cardinality per project |
|---|---|---|
| **Universal** | metamodel, authoring, YAML, prompt-pillar concepts, verify, invariants | always (one copy) |
| **TS migration / schema tooling** | the Node `meta migrate` / `migrate-ts` engine | always — universal *because* ADR-0015 makes migrations TS-owned for **every** port |
| **Server language** | ts · java · kotlin · csharp · python | one (or more in a polyglot monorepo) |
| **Client framework** (always TS) | react · tanstack · angular | zero-or-more, independent of server |

A concrete project resolves to **universal + TS-migration + one server overlay +
0..n (TS) client overlays**. The common "polyglot" case is literally *non-TS server
+ TS client* (e.g. a Java backend + React frontend).

**Worked example — a "Java server + React client" project scaffolds only what it
uses:**

```
consumer-project/
├── .metaobjects/AGENTS.md + CLAUDE.md      # slim always-on: universal essentials
│                                           #  + "Stack: java server, react client; migrations are TS"
│                                           #  + skill pointers   (NO language bodies inlined)
└── .claude/skills/
    ├── metaobjects-authoring/SKILL.md                       # universal
    ├── metaobjects-codegen/{SKILL.md, references/java.md}    # ONLY java — not the other 4 servers
    ├── metaobjects-runtime-ui/{SKILL.md, references/{java.md, react.md}}
    ├── metaobjects-prompts/{SKILL.md, references/java.md}
    └── metaobjects-verify/{SKILL.md, references/migration.md}  # TS migration tooling (universal)
```

A Python+TanStack project gets `python` + `tanstack` instead. Nothing carries the
languages it doesn't use.

> **Update (2026-06-23) — SUPERSEDED (deploy-all):** `references/<lang>.md` fragments
> are now deployed for **all** languages, not stack-selectively. Stack-detection misses
> (e.g. a monorepo whose root `package.json` lacks the deps — as happened to this repo's
> own init, which recorded `servers: []`) were *silently* starving agents of every
> language reference. Deploy-all is robust: the agent reads the reference matching its
> stack (`SKILL.md` points to them), and a detection miss can never leave a skill
> reference-less. The always-on AGENTS.md/CLAUDE.md stay stack-aware, and point 2's
> body→reference progressive disclosure still holds. Implemented by removing the token
> filter in `assemble.ts`; see `docs/superpowers/plans/2026-06-23-agent-context-deploy-all-references.md`.

**Context is optimized at two levels:**
1. **Scaffold-time selection** — the init command detects the stack (`package.json`
   deps → react/tanstack/angular; `pom.xml`/Gradle → java/kotlin; `*.csproj` → C#;
   `pyproject` → python) or takes `--server`/`--client` flags, and writes **only**
   the matching `references/<lang>.md` fragments. Fragments are per-language-named
   and **additive** (idempotent, hash-tracked) — in a true polyglot monorepo you can
   run each port's init and they accumulate without clobbering.
2. **Load-time progressive disclosure** — the always-on Markdown stays tiny (it just
   *names* the stack). A `SKILL.md` body (universal) loads only when its task is
   triggered; a `references/<lang>.md` fragment loads only when the body sends Claude
   into language-specific detail (a second-level, on-demand read).

Net: universal concepts written once; migration tooling shared; **each language is
its own file** (never concatenated), installed only if used and loaded only when
needed.

## Content model — the shared source

Proposed location: **`agent-context/`** at the monorepo root (peer of `spec/` and
`fixtures/`), so it is obviously cross-port and not TS-owned.

The `core/` section list below was validated against an audit of all 21 ADRs,
the `docs/features/*` + `spec/*` corpus, and the legacy `metaobjects-core` concept
docs (see *Design-information coverage* appendix). It is the full concept corpus;
the always-on Markdown is a slim digest of it and each skill bundles the relevant
subset.

```
agent-context/
├── core/                          # PORT-AGNOSTIC, AI-facing, self-contained
│   ├── overview.md                # what MetaObjects is; metamodel-is-the-spine; local-first; no-runtime-dep; the four pillars; the "metadata loader ≈ ClassLoader" mental model (load-once, permanent, cached reads, deferred extends resolution)
│   ├── principles.md              # working principles: pattern-derivable = codegen / never hand-write; never hand-edit generated files (regen + three-way merge); use the generated constants block for any metadata string
│   ├── metamodel.md               # base types (authority = constants.ts; ~11 + `template`); FUSED-KEY node encoding `{"<type>.<subType>": {...}}`; reserved structural keys + canonical body-key order; the two violation rules (attr uniqueness; `@attr` inline/child duality); package paths (`::`, `..::`); extends vs overlay vs abstract + DEFERRED extends resolution; object subtypes entity/value/base
│   ├── authoring.md               # YAML sigil-free desugar + the coercion footgun (quote any bool/number/date scalar; ERR_YAML_COERCION); canonical JSON; field subtypes (string/int/long/double/boolean/date/timestamp/decimal/currency/enum/uuid/object); identities (primary/secondary/reference + @generation); relationships (composition + @cardinality; @onDelete/@onUpdate); validators (field-layer vs view-layer); views + layout.dataGrid; documentation common attrs (`notes` is internal-only)
│   ├── sources-and-storage.md     # source.rdb + @kind (read-only derives from kind); @table/@column (NOT @name/@dbColumn); @schema; multi-source @role (exactly one primary); LOGICAL field subtype vs PHYSICAL @dbColumnType; @storage flattened|jsonb|subdocument; origins (passthrough/aggregate/collection) → projections
│   ├── runtime-and-api.md         # runtime return-type contract (native in-process types, not wire strings; TS decimal = string); param-passing generated repo helpers (no module `db` singleton); the REST contract — URL grammar, filter operators + bracketed-qs grammar gated by subtype, sort, limit/offset pagination, withCount, currency = integer minor units on the wire, UUID canonical hex, error envelope; the EntityFetcher browser contract
│   ├── prompt-construction.md     # the fourth pillar: template.prompt/output (@payloadRef/@textRef/@format); payload = object.value projection (origin.* fields); provider-resolved external text; render() determinism; verify --templates drift gate; parser-on-receipt for template.output
│   ├── verify-and-migrations.md   # the drift sources; verify subverbs --db/--codegen/--templates; schema migrations are the shared TS engine for EVERY port (meta migrate / verify --db are Node-only); the @generated header + never-hand-edit rule
│   ├── invariants.md              # the deduped cross-language contracts an assistant must NEVER violate (currency minor units; native runtime return types; TS-only migrations; source.rdb + @table/@column; logical-vs-physical; object entity/value only; sigil-free YAML; structured error codes; …)
│   ├── extending.md               # (advanced) adding subtypes/attrs via a MetaDataTypeProvider; register vs registry.extend vs abstract+extends — default to the lightest; never edit core
│   └── glossary.md                # terms (source.rdb, projection, payload, origin, overlay, extends, ValueObject, ObjectManager, recover/extract, …) + the stable ERR_*/WARN_* loader codes
├── tooling/
│   └── migration.md               # UNIVERSAL TS-owned schema tooling (meta migrate / migrate-ts) — every project, any server language (ADR-0015)
├── lang/
│   ├── server/                    # pick ONE (or more for a polyglot monorepo)
│   │   ├── typescript.md          # Drizzle/Zod/Fastify(+Hono) codegen + runtime-ts; npm install
│   │   ├── java.md                # Spring codegen + OMDB runtime; Maven coords; meta:gen / meta:agent-docs
│   │   ├── kotlin.md              # KotlinPoet/Exposed/Spring; Maven coords (+ metadata-ktx)
│   │   ├── csharp.md              # EF Core/ASP.NET; dotnet meta
│   │   └── python.md              # Pydantic/FastAPI; metaobjects console-script
│   └── client/                    # ALWAYS TypeScript — pick 0..n, independent of server
│       ├── react.md               # @metaobjectsdev/react (useEntityForm, CurrencyInput) + codegen-ts-react
│       ├── tanstack.md            # @metaobjectsdev/tanstack (EntityGrid, fetcher) + codegen-ts-tanstack
│       └── angular.md             # @metaobjectsdev/angular + codegen-ts-angular
├── skills/                        # SHARED SKILL.md body + per-language reference FRAGMENTS
│   ├── metaobjects-authoring/SKILL.md             # universal (no language fragment needed)
│   ├── metaobjects-codegen/
│   │   ├── SKILL.md                               # universal codegen concepts + "see references/<server>.md"
│   │   └── references/                            # assembled from lang/server/* — only the project's server(s)
│   ├── metaobjects-runtime-ui/
│   │   ├── SKILL.md                               # universal runtime+API + "see references/<server>.md and <client>.md"
│   │   └── references/                            # server + client fragments (only the project's)
│   ├── metaobjects-prompts/
│   │   ├── SKILL.md                               # universal prompt-pillar concepts
│   │   └── references/                            # per-server parser-on-receipt specifics (only the project's)
│   └── metaobjects-verify/
│       ├── SKILL.md                               # universal verify/drift
│       └── references/migration.md                # the TS migration tooling fragment (universal)
└── templates/
    ├── always-on.md.mustache  # the slim AGENTS.md/CLAUDE.md (core digest + the project's stack line)
    ├── llms.txt.mustache       # the website index (incl. the AI-bootstrap section)
    └── llms-full.txt.mustache   # the full corpus
```

**Source-of-truth decision (and a critical caveat).** `agent-context/core/` is the
**AI-facing distilled source**, authored **fresh from the canonical sources**:
`docs/features/*`, `spec/wire-format.md`, `spec/yaml-house-style.md`, and
`packages/metadata/src/constants.ts` (the canonical vocabulary). `docs/features/*`
stays the **human long-form** reference. We do **not** keep the two byte-equal
(brittle); instead the cross-language vocabulary in `core/` (subtype names, filter
operators, attr names) is asserted against `constants.ts` by a small drift test,
and the conformance gate (below) pins the **assembled scaffolded output**.

> ⚠️ **Do NOT port the current scaffolded body verbatim.** The audit found three
> sources that are **stale on the metamodel encoding** and would actively mislead
> an assistant: the existing scaffolded `sdk/src/agent-docs/body.ts` (uses the
> pre-v2 expanded `{object:{subType:entity}}` form, "8 base types", `merge:true`),
> `packages/metadata/METAMODEL.md`, and parts of `spec/metamodel.md`
> (lists retired `source.dbTable`/`dbView`). Their **prose** (working principles,
> currency, projections, filtering) is sound and reusable; their **encoding
> examples** are wrong vs. the fused-key canonical form. P0 authors `core/` from
> the canonical sources above; P1 *replaces* the stale body rather than evolving
> it. Fixing `METAMODEL.md` and `spec/metamodel.md` is a recommended side-fix
> (tracked in *Open questions*).

## Surface 1 — the always-on Markdown (portable)

Slim. Scaffolded as **both** `.metaobjects/AGENTS.md` and `.metaobjects/CLAUDE.md`
(AGENTS.md = the emerging cross-tool convention; CLAUDE.md for Claude). Contents:
- A **stack line** naming the resolved axes — e.g. "Stack: java server, react
  client; migrations are TS" — so an assistant knows the project shape without
  loading any language fragment.
- The working principles (≤ ~5 bullets).
- "Metadata lives in `metaobjects/`; here is how to regenerate" — the **project's
  server-language** one-line codegen command.
- The two violation rules + package-path notation.
- A **pointer**: "For deep authoring / codegen / runtime / prompts / verify work,
  use the matching `metaobjects-*` skill (Claude Code), whose body links the
  installed `references/<lang>.md` fragment for this stack."

Target ≤ ~120 lines so importing it whole into a root `CLAUDE.md` stays cheap.

**Root-memory wiring (opt-in).** The init command *offers* to append one import line
(`@.metaobjects/AGENTS.md`) to the consumer's root `CLAUDE.md`/`AGENTS.md` if one
exists; it never auto-edits without consent and never clobbers. A `--wire-root`
/ `--no-wire-root` flag controls it non-interactively.

## Surface 2 — the skills (Claude Code)

Five narrow skills, scaffolded into `.claude/skills/metaobjects-<x>/`. Each has a
**universal `SKILL.md` body** (≤ ~500 lines, sharp `description`) plus, where the
task is language-specific, **`references/<lang>.md` fragments** the body links to.
Only the project's resolved server/client fragments are written (per *Layering &
context optimization*) — downstream has no `docs/`, so the body + installed
fragments are self-contained. Descriptions:

| Skill | `description` (triggering text) |
|---|---|
| `metaobjects-authoring` | "Use when authoring or modifying MetaObjects metadata — fields, entities, relationships, sources, enums, abstracts/inheritance — in YAML or canonical JSON." |
| `metaobjects-codegen` | "Use when configuring or running MetaObjects code generation: generators/targets/dialect config, the gen command, and hand-edit-preserving regeneration." |
| `metaobjects-runtime-ui` | "Use when wiring MetaObjects generated code into an app: runtime queries/CRUD, REST routes, and the web client (forms, grids, filters)." |
| `metaobjects-prompts` | "Use when declaring or using MetaObjects prompt construction: `template.prompt`/`template.output`, typed payload projections, provider-resolved text, deterministic render, prompt-drift verify, and parser-on-receipt." |
| `metaobjects-verify` | "Use when verifying MetaObjects: drift checks (`verify --db/--codegen/--templates`), schema migrations, and interpreting conformance/test failures." |

`metaobjects-prompts` is the most opt-in (many adopters use only the entity/CRUD
path) — but skills are zero-cost until triggered, so a dedicated skill keeps the
other four focused on the common case. P1 dogfoods the five-way split before the
per-port fan-out locks it.

- **Superpowers stance:** independent. `metaobjects-authoring` *optionally* says
  "for non-trivial schema design, use `/superpowers:brainstorming` if installed;
  otherwise proceed." No hard dependency.
- **Opt-out:** `--no-skills` skips skill scaffolding for users who don't want
  MetaObjects writing into their `.claude/` directory.
- **Refresh discipline:** content-hash tracked like today's AGENTS.md; `--refresh-docs`
  rewrites only unmodified scaffolded files, never hand-edited ones.

## Surface 3 — the website (`llms.txt` / `llms-full.txt`)

- The monorepo **assembles** canonical `llms.txt` + `llms-full.txt` from
  `agent-context/` (+ the spec/docs corpus). `llms-full.txt` is regenerated fresh,
  killing the current staleness.
- `llms.txt` gains a prominent **"For AI assistants adopting MetaObjects"** section:
  per-port install command + init command + "then load the scaffolded
  `.metaobjects/AGENTS.md` and `.claude/skills/metaobjects-*`."
- The `metaobjects.dev` repo **consumes** the generated files (a copy script or CI
  pull), per its own README's "GitHub source wins" model. No hand-maintained second
  copy. **Cross-repo:** the spec and generator live in the monorepo; the consuming
  edits land in the separate `/…/metaobjects.dev` repo.

## Per-port delivery

| Port | Bundles content in | Init / emit command (writes the two surfaces into the consumer project) |
|---|---|---|
| TypeScript | `@metaobjectsdev/cli` (exists) | extend `meta init` / `meta init --refresh-docs` |
| Java / Kotlin | `metaobjects-maven-plugin` | new `meta:agent-docs` goal (writes `.metaobjects/*` + `.claude/skills/*`) |
| Python | `metaobjects` package | `metaobjects init` / `metaobjects agent-docs` |
| C# | `dotnet meta` tool | `dotnet meta agent-docs` |

Each port bundles the *assembled* content (universal core + **all** `lang/`
fragments + tooling) in its published artifact; the command is a select + copy +
hash-track, not a re-render on the consumer side.

**Stack resolution.** Each init command resolves the project's axes (detect from
manifests, or `--server`/`--client` flags) and writes **only** the matching
fragments. Because the **client overlays are always TypeScript**, every port's init
can install a client fragment (a Java backend serving React gets `react.md`) — the
client fragments are not TS-port-specific. The universal `tooling/migration.md`
fragment is always installed regardless of server language (migrations are TS-owned,
ADR-0015). Fragments are per-language-named and additive, so in a polyglot monorepo
running two ports' init commands accumulates fragments without clobbering.

## Conformance gate

`fixtures/agent-context-conformance/` (mirrors `render-conformance/`). Two golden
tiers:
- **Universal golden** — the assembled always-on Markdown core + the five
  `SKILL.md` bodies + `tooling/migration.md`. Identical regardless of which port
  emits it; every port's emit command must reproduce it byte-for-byte.
- **Per-language fragment goldens** — one golden per `lang/server/<lang>.md` and
  `lang/client/<framework>.md` (and each `references/<lang>.md`). A fragment's
  golden is the same no matter which port's init writes it (the `react.md` a Java
  init emits == the `react.md` a TS init emits).

This guarantees cross-port equivalence of the shared content AND that a given
language fragment is identical across the init commands that can emit it, and it
catches drift whenever the source or a `--refresh-docs` changes output.

## Phasing (decomposition; each independently shippable)

- **P0 — shared source + gate.** Create `agent-context/` (core + `tooling/migration.md`
  + `lang/server/*` + `lang/client/*` + skill bodies/references + templates), the
  assembler + stack-resolver, the vocabulary drift test, and the
  `agent-context-conformance` universal + per-fragment goldens + runner.
- **P1 — TS pilot.** Evolve `meta init` to resolve the stack and scaffold the slim
  always-on Markdown (with the stack line) + the five skills, **replacing** (not
  porting) the stale single blob, installing the `typescript` server fragment +
  detected client fragments (`react`/`tanstack`) + `migration`; opt-in root wiring;
  `--no-skills`; `--server`/`--client` overrides; conformance green for TS +
  react/tanstack. Dogfood the granularity here before fan-out.
- **P2 — per-port fan-out.** Java/Kotlin (`meta:agent-docs`), Python, C# emit
  commands consuming the shared content + their server fragment + (TS) client
  fragments + migration; add the `angular` client fragment; conformance green for
  all five servers × all client fragments.
- **P3 — website coupling.** Monorepo assembles canonical `llms.txt` +
  `llms-full.txt` (fresh corpus + the AI-bootstrap section); `metaobjects.dev`
  consumes them. Cross-repo.
- **P4 — (optional, later) plugin.** A `metaobjects` Claude Code plugin +
  marketplace bundling the same skills for `/plugin install`; the scaffolder
  remains for non-plugin and non-Claude users.

## Risks & open questions

- **Granularity of the five skills** may need tuning — P1 dogfooding validates
  before the per-port fan-out locks it in.
- **Stack mis-detection** — manifest sniffing can misread a project (monorepo with
  several manifests, unusual layout). Mitigation: detection is a *suggestion* the
  init command shows and confirms, always overridable by `--server`/`--client`; a
  wrong guess writes an extra fragment, never a wrong one.
- **Writing into the consumer's `.claude/`** must stay polite: namespaced
  (`metaobjects-*`), hash-tracked, never clobber, `--no-skills` escape hatch. Same
  discipline already proven for the scaffolded AGENTS.md.
- **Non-TS scaffolding ergonomics** — a Maven goal / pip console-script writing
  `.claude/` files is slightly unusual but mechanically fine; the content is
  pre-assembled so each command is a copy.
- **Cross-repo sync for `llms.txt`** — decide manual copy script vs CI pull in P3;
  lean CI pull triggered on monorepo release tags.
- **Two AI-facing vs human-facing doc sources** (`agent-context/core` vs
  `docs/features`) — accepted, bounded by the vocabulary drift test rather than full
  content sync.
- **Recommended side-fixes (out of scope but adjacent):** `packages/metadata/METAMODEL.md`
  and `spec/metamodel.md` are stale on the fused-key encoding / retired source
  subtypes. They are not part of this work, but since P0 reads the canonical
  sources anyway, flag/fix them opportunistically so they stop misleading
  assistants that read the repo directly.
- **ADR status caveats to encode in `core/`:** ADR-0018 (per-kind physical-name
  attrs like `@view`/`@proc`) is *Proposed/unimplemented* — present `@table` as
  current, per-kind aliases as forthcoming. ADR-0015/0016/0020/0021 (migrate
  engine, codegen surface, verify subverbs) are TS-reference-shipped with per-port
  fan-out staged — state the contract, caveat per-port availability. The
  `recover`→`extract` rename is queued — method names may shift.

## Appendix — Design-information coverage

Validates that the content model covers the downstream-relevant design knowledge
surfaced by auditing all 21 ADRs, the `docs/features/*` + `spec/*` corpus, and the
legacy `metaobjects-core` concepts. Each row: a knowledge area an adopter's
assistant must be aware of → where it lives.

| Design knowledge (source) | Covered by |
|---|---|
| Metamodel-is-spine, local-first, no-runtime-dep, four pillars (philosophy) | `core/overview.md` |
| "Loader ≈ ClassLoader" mental model: load-once, cached, deferred `extends` resolution (legacy concept, still true) | `core/overview.md` + `core/metamodel.md` |
| Pattern-derivable = codegen; never hand-edit generated files; use generated constants | `core/principles.md` |
| Fused-key node encoding; base types (constants.ts); reserved keys + body-key order; the two violation rules; package paths; extends/overlay/abstract | `core/metamodel.md` |
| Object subtypes = entity/value/base only; no representation attr (ADR-0005) | `core/metamodel.md` + `core/invariants.md` |
| Sigil-free YAML desugar + coercion footgun; canonical JSON `@`-interchange (ADR-0006) | `core/authoring.md` |
| Field subtypes incl. currency/enum/uuid/object; identities; relationships + `@onDelete`/`@onUpdate`; validators (field vs view); views; layout.dataGrid; documentation attrs (`notes` internal) | `core/authoring.md` |
| `source.rdb` + `@kind`; `@table`/`@column`; `@schema`; `@role` one-primary (ADR-0007/0018) | `core/sources-and-storage.md` + `core/invariants.md` |
| Logical field type vs physical `@dbColumnType`; `@storage` flattened/jsonb/subdocument (ADR-0013) | `core/sources-and-storage.md` |
| Origins (passthrough/aggregate/collection) → projections | `core/sources-and-storage.md` |
| Codegen config/generators/targets/dialects (D1 = TS-only)/naming-strategy; three-way-merge regen; stable generator names + `--list` (ADR-0020/0021) | `core/verify-and-migrations.md` + `metaobjects-codegen` skill |
| Param-passing generated repo helpers — no `db` singleton (ADR-0008) | `core/runtime-and-api.md` + `core/invariants.md` |
| Runtime return-type contract — native in-process types, decimal exact, TS decimal = string (ADR-0019); `newInstance`/get-set/ValueObject (ADR-0017) | `core/runtime-and-api.md` + `core/invariants.md` |
| REST contract: URL grammar, filter operators + bracketed-qs grammar by subtype, sort, limit/offset, withCount, error envelope; EntityFetcher | `core/runtime-and-api.md` + `metaobjects-runtime-ui` skill |
| Currency = integer minor units on the wire; UUID canonical hex (wire invariants) | `core/runtime-and-api.md` + `core/invariants.md` |
| Prompt pillar: `template.prompt`/`output` (`@payloadRef`/`@textRef`/`@format`), payload projections, provider text, render determinism, parser-on-receipt (ADR-0010/0011) | `core/prompt-construction.md` + `metaobjects-prompts` skill |
| Drift sources; `verify --db/--codegen/--templates` (ADR-0021); migrations TS-engine-only for every port (ADR-0015/0016) | `core/verify-and-migrations.md` + `metaobjects-verify` skill + `core/invariants.md` |
| Structured loader error envelope; stable `ERR_*`/`WARN_*` codes (ADR-0009) | `core/glossary.md` |
| Extending the metamodel: provider; register vs `registry.extend` vs abstract+extends (ADR-0004/0011) | `core/extending.md` |
| Java/Kotlin = plain Maven JARs, no OSGi (ADR-0012) | `lang/server/java.md` + `lang/server/kotlin.md` |
| Per-server-language install + codegen invocation + runtime packages | `lang/server/*.md` |
| Client framework packages (always TS): react/tanstack/angular | `lang/client/*.md` |
| TS-owned migration tooling for every port (ADR-0015) | `tooling/migration.md` |

**Classified INTERNAL (not surfaced to adopters):** ADR-0001 (build-time type
binding mechanism), 0002 (open-closed nodes), 0003 (constants colocation), 0014
(loader-scoped registry) — contributor/porter concerns with no authoring, wire, or
observable runtime/codegen effect on an adopter.
