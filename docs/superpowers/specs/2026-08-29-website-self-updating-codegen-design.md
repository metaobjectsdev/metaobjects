# Website self-updating codegen — design

**Date:** 2026-08-29
**Status:** approved design, not yet implemented
**Scope:** `metaobjects` (generator + corpus + gates) and `metaobjectsdev.github.io` (placeholders + deploy injection)

## Problem

Every code block on `metaobjects.dev` is hand-transcribed HTML, and nothing checks any of it.
There is no CI on the site, no drift check, and no example loading. The blocks make the site's
strongest claims:

> "Everything below is real `meta gen` output, conformance-gated, not hand-wired annotations."
> "this exact model loads and generates a full typed stack … with zero errors and zero warnings"

Neither claim is enforced, and both are already inaccurate in small ways. The `blog::Author`
source block elides three members behind a `# …` comment while the prose calls it "this exact
model". In `requirements.html`, `- requirement.functional:` is marked up as a *comment* —
rendered in comment gray, as though the subtype declaring the node were a remark. In
`prompts-are-code.html`, subtypes and attributes share one colour, so `template.prompt:` is
indistinguishable from `name:`.

The site also carries 31 version references that are hand-edited at every cut, and two `llms`
mirrors kept in sync by manual copy.

Three separate jobs, one transport:

- **B — example snippets.** Site code examples drift silently. Highest value; done first.
- **A — version payload.** 31 refs, hand-edited every release.
- **C — llms mirrors.** `docs/llms/{llms,llms-full}.txt` → site, currently a manual copy.

B first because it is the one that has actually been *wrong*, with no gate. A and C are
payload-shaped once B's extract → emit → transport path exists.

## Non-goals

- `metaobjects.com` is out of scope. It carries zero metadata examples and zero version
  references (Eleventy/njk, content-driven). If it later grows a version reference, it consumes
  the same payload; nothing here needs to change.
- No client-side JavaScript. The site has zero `<script>` tags today and keeps it that way.
- No new metamodel vocabulary. This work reads the metamodel; it does not extend it.

## Decisions

### D1 — The generator owns input *and* generated-output blocks, for all five ports

The output blocks carry the site's strongest claim, so leaving them hand-written would leave the
claim unenforced. All five ports already generate from one shared model at build time (each
port's generated-artifact lane runs against `fixtures/api-contract-conformance/`), so this is a
capture problem, not a new-toolchain problem.

*Rejected:* inputs only (leaves the load-bearing claim ungated); a verification-only gate on
outputs (does not remove the hand-editing this work exists to remove).

### D2 — Inline excerpt plus expand-to-full-file

The inline block stays roughly its current size; the full generated file ships alongside it
behind a `<details>`. This keeps the page's density *and* increases what it can prove: a reader
can check the excerpt against the file it came from.

Real generated `Author.ts` for a **two-field** entity is 69 lines with 10 exports — table,
select/insert/update types, insert/update schemas, patch type, metadata constants, filter
allowlist, sort allowlist, filter type. The site shows 4 of them. That selection is an editorial
decision, not a truncation, so something has to express it.

*Rejected:* publishing whole files inline (a 69-line block for a 2-field entity is not the page
we want).

### D3 — The excerpt is declared *in* the file when the file is ours to edit, and *beside* it when it isn't

- **Hand-authored metadata YAML** carries marker comments (`# >>> snippet: <id>` / `# <<<`). The
  file is human-owned and never rewritten, so the markers survive indefinitely, and there is no
  duplicated copy to keep in sync.
- **Generated output** cannot carry markers: every regen rewrites the file. The excerpt is a
  small committed file beside the corpus, and a gate asserts it is an in-order subsequence of the
  real generated file.

*Rejected:* teaching every port's codegen to emit website markers — that pollutes every adopter's
generated files for the website's benefit. *Rejected:* line ranges (do not survive a regen).
*Rejected:* extracting by declaration name (fully automatic, but needs a declaration-start
grammar per language, and lets a body change reach the page unreviewed).

### D4 — The site pulls at deploy, pinned to the latest release tag

The site's `deploy.yml` already clones a *different* public repo at deploy time, runs the
published CLI, and drops the output into `www/reference/` — with no cross-repo secrets. This
follows that established pattern rather than inventing a second one.

Pinning to the latest **release tag**, not `main`, is load-bearing: an unrelated site edit
triggers a deploy, and against `main` that deploy would publish unreleased snippets.

*Rejected:* the release step pushing a commit into the site repo (needs a cross-repo token, and
adds a Pages deploy trigger to release day — a failed Pages deploy is expensive to recover).

### D5 — One number per registry, never a single "version" string

The version payload carries a per-registry coordinate. npm/PyPI/NuGet share a `minor.patch`
today and Maven is on `7.x`; at 1.0 they decouple further (npm/PyPI/NuGet → `1.0.0`,
Maven → `8.0.0`, `metamodelVersion` → `1.0`). A payload with one `version` field would bake in a
premise the project has explicitly decided against (ADR-0035 Amendment 2 — two contracts, two
numbers).

## Architecture

```
examples/showcase/metaobjects/*.yaml          hand-authored → markers live IN the file
examples/advanced-modeling/metaobjects/*.yaml
        │
        ├─ TS      meta gen        ─┐
        ├─ Java    mvn generate    ─┤
        ├─ Kotlin  mvn generate    ─┼─► examples/showcase/generated/<port>/**   COMMITTED
        ├─ C#      dotnet meta gen ─┤    (machine-owned → excerpt lives BESIDE)
        ├─ Python  metaobjects gen ─┤
        └─ SQL     meta migrate    ─┘
                    │
        examples/showcase/inline/<port>.<file>   COMMITTED hand-cut excerpts
        examples/showcase/drift/                 a fixture that deliberately FAILS verify
                    │
                    ▼
        scripts/build-site-payload.ts
          1. assert each inline excerpt is an in-order subsequence of its full file
          2. compute gap positions → auto-insert `…` elision markers
          3. highlight → the site's four classes
          4. capture CLI transcripts, normalised
          5. emit site-payload.json                COMMITTED, diff-reviewable at release
                    │
                    ▼    site deploy.yml: clone metaobjects @ latest release tag
        inject into www/*.html placeholders → upload-pages-artifact
```

**The payload is committed rather than built at deploy** so the site workflow stays a `clone`
plus a `read` (no `bun install`, no toolchains), and so the snippet diff is reviewable in this
repo at release time instead of appearing first on the live site.

## The showcase corpus

`examples/showcase/` is new and deliberately small: roughly today's `Subscriber` — one entity,
five fields, an enum, an `@autoSet` timestamp, an `increment` primary key. It is sized for the
five-language section and nothing else.

`examples/advanced-modeling/` is reused for the "metamodel goes deep" section. It already carries
a projection with origins, a currency view and field-level validators, and it is already
drift-gated. Its prose on the site moves from the fictional `blog` package to the real
`acme::learn`.

The showcase also declares a `template.prompt` with a `@payloadRef` and a `@textRef`, plus the
template text file it names. This is required by `prompts-are-code.html`, whose YAML block shows a
payload beside a prompt, and it cannot reuse `examples/advanced-modeling`'s node because that one is
a `template.output` — a different subtype from the one the article displays.

It carries **no `@responseRef`**, so it exercises no part of the inbound tier: since 0.24.0 the
parser, tolerant extractor and response-format fragment all key off `@responseRef` (ADR-0052). That
is correct for what the article shows — its transcript is `ERR_VAR_NOT_ON_PAYLOAD`, a check of the
prompt's own variables against its own payload, which needs no response type.

`examples/showcase/drift/` exists **to fail**. It is the showcase prompt with one payload member
renamed, so `meta verify` produces a real `ERR_VAR_NOT_ON_PAYLOAD`, which is the content of that
page's transcript block. Keeping it a separate fixture is what lets the showcase itself stay
green.

`scripts/regen-showcase.ts` runs all five ports against the showcase and writes
`generated/<port>/**`. All five toolchains are present on the maintainer's machine
(Maven, .NET, uv, Bun, Node), so this runs locally.

## Block kinds

Five kinds, each with its own source of truth:

| # | Kind | Source | Excerpt mechanism |
|---|---|---|---|
| 1 | Metadata YAML | hand-authored showcase / advanced-modeling | markers in the file |
| 2 | Generated code (TS/Java/Kotlin/C#/Python/SQL) | `regen-showcase` output | committed excerpt + subsequence gate |
| 3 | Requirement ledger entry | showcase `requirement.functional` | markers in the file |
| 4 | CLI transcript | live capture from `examples/showcase/drift/` | whole capture, normalised |
| 5 | Generated test stub | `requirementTests()` output | committed excerpt + subsequence gate |

### The fifth pillar — requirements and testing

The site presents four pillars. Requirements and testing is now a fifth, and it has real shipped
surface: `requirement.functional` / `requirement.architectural` vocabulary enforced by the
loader, `meta verify` resolving `@implementedBy` and printing a requirements summary on every
run, an authoring lint, a `meta docs` requirements surface, and `requirementTests()` scaffolding
a test stub per claim carrying the statement and counterexample in.

**Accuracy constraint, load-bearing for the site's copy:** the *vocabulary and `verify` checks*
are cross-port (TypeScript, Java, Python, C#; Kotlin via the JVM loader). **`requirementTests()`
is TypeScript-only.** The site must not imply five-language test generation. The pillar card and
the generated snippets state the split explicitly.

The showcase therefore declares one `requirement.functional` whose `@implementedBy` resolves to a
real member of the showcase entity — `Subscriber.status`, telling the same story the current page
tells about a fictional `arena::Bot`: *a subscriber can be paused without erasing their history*.
Because the link resolves against a real field, the page's central claim — "resolved, not
trusted" — becomes demonstrable rather than illustrated. Its generated `requirementTests()` stub
is kind 5.

## The snippet contract

`site-payload.json` is keyed by snippet id. Each entry carries `{ lang, inline, full, lineCount }`,
both HTML fields pre-highlighted.

**The subsequence gate.** Every line of the committed inline excerpt must appear, in order,
inside the real generated file, compared after trimming so trailing whitespace cannot fail it.
Failure names the snippet, the file, and the first line that no longer matches.

It is a subsequence, not a contiguous block — necessary, because the page shows exports 1, 3 and
7 of a file and skips the rest. It catches a declaration renamed or dropped, a type or annotation
changing on a shown line, and output reordering. It does **not** catch new output appearing in a
gap between excerpt lines; the excerpt stays true but not exhaustive, and the full file ships
alongside it, so the addition is one click away rather than hidden.

**Elisions are computed, not authored.** The builder knows where the matched lines skipped, so it
inserts `…` at each gap. The page cannot imply contiguity it does not have — which is exactly how
the current `blog::Author` block came to claim "this exact model" while eliding three members.

**Dedent.** A marker-extracted region is dedented by its common leading indent, so a fragment
pulled from deep inside a `children:` tree reads at the left margin as it does today, with
relative structure preserved.

**Highlighting runs at build time** and emits the site's existing class names, so `styles.css` is
untouched and the page looks as it does now. Two highlighters:

- **Metadata YAML — registry-driven.** `fixtures/registry-conformance/expected-registry.json`
  lists every `type.subType`, so `object.entity` and `field.string` are coloured as subtypes
  *because the registry says they are*, not because a regex guessed. Reserved structural keywords
  and registered attribute names colour as keys. Anything else is an error, which is a second
  drift signal for free: a site example using retired vocabulary fails the build instead of
  shipping in the wrong colour.
- **Generated code and transcripts** — a library highlighter at build time, its token scopes
  mapped onto the same classes. No client JS.

> **Corrected during implementation (Task 4).** This is a REPORT, not a failure. A
> closed-world key check cannot be written: `attr.properties` is a chartered arbitrary
> bag (ADR-0023) and `attr.expression`/`attr.filter` carry their own node grammars whose
> inner keys are not registry attrs. Against the real corpora a throwing version produced
> 8 false failures. The vocabulary gate is the LOADER — strictly stronger, no false
> positives, and already run by both corpora's drift gates. Vocabulary also comes from
> `spec/metamodel/*.json` as well as `expected-registry.json`, because the cross-port
> manifest omits TS-side provider subtypes (`view.image`, `view.textarea`) that a shipped
> example uses.


**Palette unification.** `index.html` uses `comment` / `keyword` / `key` / `string`;
`requirements.html` and `prompts-are-code.html` use `tok-cmt` / `tok-key` / `tok-val` / `tok-ok` /
`tok-err`. The payload emits one set — the `index.html` names plus `ok` / `err` for terminal
blocks — and the two pages migrate. Before deleting the `tok-*` rules, audit whether those
classes are used outside code blocks on those pages; if they are, the rules stay and only the code
blocks migrate.

**Transcript normalisation is a hygiene requirement, not a nicety.** Raw CLI output carries
absolute paths. Committing a home path into a payload that publishes to a public site would
violate the repository's public-hygiene rule at the exact moment nothing is watching. Capture
strips paths to repo-relative and drops timings; the payload build fails on any absolute home
path.

## Site integration

Committed HTML holds a placeholder:

```html
<pre class="example-code" data-snippet="ts/Subscriber"></pre>
```

The injector fills it and wraps the full file in a `<details>` — pure HTML, no script:

```html
<pre class="example-code" data-snippet="ts/Subscriber">…inline…</pre>
<details><summary>Show the whole generated file (69 lines)</summary>
  <pre class="example-code">…full…</pre></details>
```

The injector enforces a **bijection**. A placeholder with no payload entry ships an empty code
block; a payload entry no page references means an example silently vanished. Both fail.

**Mitigating the placeholder-in-git trade.** Committed HTML no longer shows what ships, which is
the accepted cost of D4. Two mitigations: the same injector runs locally (`bun run site:preview`)
so the real page is viewable before pushing; and because a failed Pages deploy is expensive to
recover, the bijection check **also runs in this repo's release preflight**, reading the site's
HTML over HTTPS from the public repo — so a mismatch fails the release, before the tag, rather
than the deploy.

## A — version payload

Smaller than "31 refs" suggests. Twenty are inside `llms.txt` / `llms-full.txt`, which C makes
generated. The remaining ten are a single per-port table on `index.html` — five rows, each with a
status badge and an inline package coordinate — and the whole table is derivable from release
state.

The payload gains a `registries` block carrying one coordinate per registry plus
`metamodelVersion`, per D5. The table's five rows render from it.

## C — llms mirrors

`docs/llms/{llms,llms-full}.txt` → `www/`, as a copy step in the same deploy job. The two are
byte-identical today, so this codifies the current state rather than changing it.

**What C does and does not do, stated precisely:** the mirrors contain 20 literal version strings of
their own, and copying them does not generate those. It stops them being maintained in TWO repos and
leaves them maintained in ONE. Generating them from the `registries` block is a real follow-on,
deliberately excluded here because `docs/llms/*` is also read directly by agents out of this repo, so
templating it changes an adopter-facing artifact and deserves its own decision.

## Gates

| Gate | Runs | Catches |
|---|---|---|
| Excerpt subsequence | release preflight | An excerpt that no longer appears in real output |
| Showcase freshness (`regen-showcase`, no diff) | release preflight | Committed output stale vs current codegen |
| Registry-driven highlight (**report**) | payload build | An unplaceable key surfaced; vocabulary itself is gated by the loader |
| Placeholder ↔ payload bijection | release preflight + deploy | Empty blocks; silently dropped examples |
| Per-port showcase drift | port lanes (release tags) | A port's codegen changing shape |
| Drift fixture still fails | payload build | A transcript block gone quietly green — a stale error on the page |
| Requirement link resolves | payload build | `@implementedBy` dangling, i.e. the page's own claim being false |
| No absolute paths in payload | payload build | Home paths leaking to a public site |

Tests first, per the repository's discipline: each gate gets a failing test before its
implementation.

## Limits and risks

Stated rather than discovered later.

- **Five ports of generated output are committed, and need regenerating whenever any port's
  codegen changes shape.** This is real maintenance. The payoff is that the site's strongest
  claim becomes enforced, and the repo gains a five-language input → output example it does not
  currently have anywhere.
- **Per-port drift only fires on release tags.** Java, C# and Python lanes do not run on ordinary
  pushes (by cost design), so a mid-cycle Java codegen change surfaces at the cut, not on the push
  that caused it. The gate holds at the moment site content is cut, which is where it matters, but
  the coverage is not continuous.
- **Committed site HTML shows placeholders, not shipped content.** Accepted cost of D4, mitigated
  by the local preview and the preflight bijection check above.
- **The showcase model constrains what the landing page can demonstrate.** It is deliberately
  small; anything richer belongs to the advanced-modeling half.
- **`getting-started.html` is not converted by this pass.** Its blocks are shell commands and a
  scaffolded directory tree (a third palette, `gs-code` / `s` / `c`), not metadata or generated
  code. So this work covers every *metadata and generated-code* block on the site, not literally
  every `<pre>`. The directory tree is the obvious next candidate — it is `meta init` output and
  could be captured the same way as a CLI transcript — but it is deliberately left out rather than
  folded in silently.

## D6 — `/reference` documents the metamodel, not an adopter's model

The site's `/reference` is generated from a public adopter application, so a visitor clicking
"Reference" on the MetaObjects site gets that app's entities rather than the metamodel. This was not
a decision anyone made. `meta docs --metamodel` already renders the full registry — 16 pages, index
plus per-family attribute tables, byte-gated as `fixtures/metamodel-docs/expected/` — but
`meta docs --metamodel --site` **writes those 16 markdown files and zero HTML**, because
`--metamodel` returns at `docs.ts:213-214`, before the `--site` branch. `--site` is accepted and
dropped, so the adopter path was simply the only one producing HTML.

Three consequences, each its own task: the CLI **refuses** `--metamodel --site` rather than ignoring
it (a defect that ships to adopters regardless of the website); the site pipeline renders the 16
markdown pages into the site's own shell and publishes them at `/reference`; and the adopter docs
move to `/reference/example`, relabelled as what they are — a real project documented by
`meta docs`, which is evidence a self-referential metamodel page cannot provide.

The markdown renderer stays a **devDependency in `scripts/`**, not a runtime dependency of a
published package, and the pages get the metaobjects.dev look rather than the docs-site adopter
theme.

## Sequencing

1. **B** — showcase corpus, `regen-showcase`, payload builder, gates, site placeholders and
   deploy injection. Includes all five block kinds and the fifth-pillar content.
2. **A** — `registries` block in the payload; the per-port table renders from it.
3. **C** — llms mirrors as a deploy copy step.
4. **Reference docs** — the `--metamodel --site` fix, then `/reference`, then the adopter move.
   Last because it shares the deploy workflow Task 13 rewrites; two plans editing that file is how
   they conflict.

A and C are additive to a transport B establishes, which is why they follow it rather than
competing with it.
