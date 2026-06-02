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
MONOREPO  agent-context/  ← single AI-facing source (core + port overlays + skill bodies)
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

## Content model — the shared source

Proposed location: **`agent-context/`** at the monorepo root (peer of `spec/` and
`fixtures/`), so it is obviously cross-port and not TS-owned.

```
agent-context/
├── core/                      # PORT-AGNOSTIC, AI-facing, self-contained
│   ├── overview.md            # what MetaObjects is; the metamodel-is-the-spine framing
│   ├── principles.md          # the working principles (codegen-not-hand-code, etc.)
│   ├── metamodel.md           # 8 base types, the two violation rules, package paths
│   ├── authoring.md           # YAML/JSON, fields, entities, relationships, sources, abstracts, enums
│   ├── filters.md             # filter grammar + operators by field subtype
│   └── glossary.md            # terms an assistant needs (source.rdb, projection, payload, …)
├── ports/                     # THIN per-port overlays (install + invoke + packages)
│   ├── typescript.md
│   ├── java.md                # also serves Kotlin via metadata-ktx note
│   ├── kotlin.md
│   ├── csharp.md
│   └── python.md
├── skills/                    # SKILL.md bodies (core text + {{port}} injection points)
│   ├── metaobjects-authoring/SKILL.md
│   ├── metaobjects-codegen/SKILL.md
│   ├── metaobjects-runtime-ui/SKILL.md
│   └── metaobjects-verify/SKILL.md
└── templates/
    ├── always-on.md.mustache  # the slim AGENTS.md/CLAUDE.md assembled from core+overlay
    ├── llms.txt.mustache       # the website index (incl. the AI-bootstrap section)
    └── llms-full.txt.mustache   # the full corpus
```

**Source-of-truth decision.** `agent-context/core/` is the **AI-facing distilled
source**. `docs/features/*` stays the **human long-form** reference. We do **not**
try to keep the two byte-equal (that would be brittle). Instead:
- Cross-language vocabulary used in `core/` (subtype names, filter operators, attr
  names) is asserted against the canonical constants by a small drift test, so the
  *facts* can't diverge even though the prose differs.
- The conformance gate (below) pins the **assembled scaffolded output**, not
  doc-to-doc equivalence.

## Surface 1 — the always-on Markdown (portable)

Slim. Scaffolded as **both** `.metaobjects/AGENTS.md` and `.metaobjects/CLAUDE.md`
(AGENTS.md = the emerging cross-tool convention; CLAUDE.md for Claude). Contents:
- The working principles (≤ ~5 bullets).
- "Metadata lives in `metaobjects/`; here is how to regenerate" — the **port's**
  one-line codegen command.
- The two violation rules + package-path notation.
- A **pointer**: "For deep authoring / codegen / runtime / verify work, use the
  matching `metaobjects-*` skill (Claude Code) or read this file's linked sections."

Target ≤ ~120 lines so importing it whole into a root `CLAUDE.md` stays cheap.

**Root-memory wiring (opt-in).** The init command *offers* to append one import line
(`@.metaobjects/AGENTS.md`) to the consumer's root `CLAUDE.md`/`AGENTS.md` if one
exists; it never auto-edits without consent and never clobbers. A `--wire-root`
/ `--no-wire-root` flag controls it non-interactively.

## Surface 2 — the skills (Claude Code)

Four narrow skills, scaffolded into `.claude/skills/metaobjects-<x>/SKILL.md`,
self-contained (bundle the reference excerpts they need — downstream has no
`docs/`), ≤ ~500 lines each, with sharp `description`s:

| Skill | `description` (triggering text) |
|---|---|
| `metaobjects-authoring` | "Use when authoring or modifying MetaObjects metadata — fields, entities, relationships, sources, enums, abstracts/inheritance — in YAML or canonical JSON." |
| `metaobjects-codegen` | "Use when configuring or running MetaObjects code generation: generators/targets/dialect config, the gen command, and hand-edit-preserving regeneration." |
| `metaobjects-runtime-ui` | "Use when wiring MetaObjects generated code into an app: runtime queries/CRUD, REST routes, and the web client (forms, grids, filters)." |
| `metaobjects-verify` | "Use when verifying MetaObjects: drift checks, schema migrations, and interpreting conformance/test failures." |

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

Each port bundles the *assembled* content (its overlay already merged) in its
published artifact; the command is a file-copy + hash-track, not a re-render on the
consumer side.

## Conformance gate

`fixtures/agent-context-conformance/` (mirrors `render-conformance/`): the golden is
the **assembled always-on Markdown + the four SKILL.md files** for each port. Each
port's emit command must reproduce the golden byte-for-byte for the shared core
(port overlays legitimately differ per port). This is what guarantees cross-port
equivalence and catches drift whenever the source or a refresh changes output.

## Phasing (decomposition; each independently shippable)

- **P0 — shared source + gate.** Create `agent-context/` (core + overlays + skill
  bodies + templates), the assembler, the vocabulary drift test, and the
  `agent-context-conformance` golden + runner.
- **P1 — TS pilot.** Evolve `meta init` to scaffold the slim always-on Markdown +
  the four skills (replacing the single blob); opt-in root wiring; `--no-skills`;
  conformance green for TS. Dogfood the skill granularity here before fan-out.
- **P2 — per-port fan-out.** Java/Kotlin (`meta:agent-docs`), Python, C# emit
  commands consuming the shared content; conformance green for all five.
- **P3 — website coupling.** Monorepo assembles canonical `llms.txt` +
  `llms-full.txt` (fresh corpus + the AI-bootstrap section); `metaobjects.dev`
  consumes them. Cross-repo.
- **P4 — (optional, later) plugin.** A `metaobjects` Claude Code plugin +
  marketplace bundling the same skills for `/plugin install`; the scaffolder
  remains for non-plugin and non-Claude users.

## Risks & open questions

- **Granularity of the four skills** may need tuning — P1 dogfooding validates
  before the per-port fan-out locks it in.
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
