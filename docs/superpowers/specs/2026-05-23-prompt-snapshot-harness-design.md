# Prompt snapshot harness: deterministic byte-snapshot of rendered prompts

**Status:** Design / plan-of-record. Not yet implemented.
**Depends on:** the shipped FR-004 render engine + `meta verify` CLI + `FileProvider`; and the
output-tag/`@requiredTags` slice (`docs/superpowers/specs/2026-05-23-prompt-verify-extensions-design.md`).
**Roadmap:** this is feature **#4** from the prompt-verify-extensions doc ("Prompt snapshot harness"),
broken out into its own first slice.

## Why (the gap the template's own history does not cover)

A rendered prompt is a **composition**: `template text + provider-resolved partials + payload shape +
@format escaping`. The git history of any single `.mustache` file shows only changes to *that* file —
it is blind to the two compositional inputs that most often change the prompt a model actually receives:

- **Shared partials.** When many prompts include a common preamble/rules partial
  (`{{> shared/system-preamble}}`), an edit to that partial changes the rendered output of *every*
  consuming prompt — while the consuming prompts' own files (and histories) show nothing. If that
  preamble is the prompt-cache prefix, the edit silently busts caching across all of them.
- **Payload / projection shape.** The prompt depends on the shape of the view-object it renders
  against. When that projection gains a field (or an array starts coming back populated), the rendered
  prompt grows while the `.mustache` file is untouched.

For a **standalone single-file template** with no partials and no payload-shape dependence, `git log -p`
on that file is genuinely most of the value, and this feature adds little beyond being a *pre-merge gate*
rather than after-the-fact forensics. The feature earns its keep precisely when prompts are **composed**
(shared partials and/or evolving projections) — the common case for a downstream consumer that assembles
many prompts from a shared preamble.

What this buys, concretely:

- **Cache-stability tripwire.** A whitespace/reordering change anywhere in the composition (including a
  shared partial) that would silently break exact-prefix prompt-cache hits becomes a reviewable diff and
  a CI failure, instead of a cost/latency regression discovered days later on a dashboard.
- **Payload-bloat-as-diff.** A projection change that enlarges the prompt shows up as added lines in the
  snapshot diff — invisible token creep becomes a reviewable line-count change.
- **"Exactly what prod ships."** The golden is the final rendered text (partials expanded, escaping
  applied), so a reviewer reads what the model receives instead of mentally rendering the source.

**Relationship to the `@requiredTags` slice (#2).** Complementary. `@requiredTags` is the cheap,
always-on static guard ("the rendered text still contains `<answer>`/`</answer>`"); the snapshot is the
full-fidelity guard ("here is the byte-exact diff of everything the model receives"). #2 needs no fixture;
#4 costs one representative payload per prompt and in return makes the entire rendered prompt a
checked-in artifact that diffs like code.

## Scope (first slice)

Resolved during brainstorming:

- **TS-only, reference-first.** Build the CLI command + the on-disk convention in TypeScript and prove
  it. The convention is deliberately language-neutral so a C# port adopts it identically as a later
  slice. Python and Java are out (neither has a prompt-side `render()` yet).
- **Incremental adoption.** A template with no committed fixture payload is skipped (with a notice), so a
  project snapshots only the prompts it has authored a payload for.
- **No new library helper.** The existing `render()` already returns the deterministic string a consumer
  can fold into their own test runner's snapshot matcher; a dedicated `snapshotPrompt()` would be
  near-identical sugar. Ship the CLI command; document `render()` for the in-test path.
- **Out of scope:** semantic / LLM-as-judge eval (external tools); `@maxTokens` (model-specific
  tokenizer); multiple payload cases per template (the layout leaves room — see below); the C#/Python/Java
  ports.

## Design

### CLI command

A new `meta` subcommand mirroring `meta verify`:

```
meta prompt-snapshot [--check] [--prompts <dir>] [--cwd <dir>]
```

It reuses `meta verify`'s machinery: load metadata (`loadMemory`), build a `FileProvider` over the
prompts dir (default `prompts/`, overridable with `--prompts`), and iterate the root's own `template.*`
children, reading each node's `@textRef` and `@format`.

Two modes:

- **Write mode (default, no `--check`).** For each template that has a committed `payload.json`, render
  the prompt and **write/overwrite** its `output.snap`. Templates without a `payload.json` are skipped
  with a notice. Human-driven: you run this when you author a new prompt or intentionally change one,
  review the resulting `git diff`, and commit the updated golden alongside the change. Exit 0 (unless a
  load error, unresolved `@textRef`, or render error occurs).
- **Check mode (`--check`).** For each template that has a committed `payload.json`, render and **diff**
  against the committed `output.snap`. Never writes. This is the CI gate.

### On-disk layout (committed)

```
.metaobjects/
  config.json                          # committed (existing)
  .gen-state/                          # gitignored (existing)
  snapshots/                           # COMMITTED — golden snapshots
    <TemplateName>/
      payload.json                     # the fixture input (author-owned)
      output.snap                      # the golden rendered output (tool-managed, byte-exact)
```

`.metaobjects/` is the tool-owned directory; only `.gen-state/` is gitignored, so `snapshots/` is
committed by default (consistent with `config.json`). The path is language-neutral (no JS-world
`__snapshots__/` convention), so the identical layout is portable to a future C# port. The binding key is
the template node's `name` (matching how `meta verify` already reports `[tmpl.name]`); this is
collision-safe because the loader already rejects same-name siblings (`ERR_DUPLICATE_NAME`), and
templates are siblings under `metadata.root`. The per-template
**subdirectory** groups input + golden and leaves room to add multiple payload cases later
(`<TemplateName>/<case>.payload.json` + `<case>.snap`) without a rename; this first slice writes exactly
one `payload.json` + one `output.snap` per template.

### Rendering

For each in-scope template:

1. Resolve `@textRef` to template text via the `FileProvider`. If it does not resolve → error (exactly as
   `meta verify` treats an unresolved `@textRef`).
2. Read `.metaobjects/snapshots/<name>/payload.json`. If absent → skip with a notice.
3. Render: `render({ ref: <@textRef>, payload, provider, format: <@format> })`. This goes through the
   full partial expansion + escaper pipeline, identical to production. The render engine's `maxChars`
   budget guard is **not** applied here — a snapshot records the raw rendered output; budget enforcement
   is a separate runtime concern.

The rendered string is the golden. Determinism is inherent: `render()` is logic-less and the
`FileProvider` is deterministic, so the same `payload.json` + template text + partials yield identical
bytes every run.

### Snapshot format

`output.snap` is the **raw rendered string, byte-exact**, written verbatim — no `@generated` header or
other decoration, because the file's purpose is to equal what prod ships. The tool owns the file
(humans never hand-edit it), so byte-exactness (including any absence of a trailing newline) is safe.
`--check` compares the freshly rendered string to the committed bytes exactly; no normalization, since
normalization would mask the very whitespace drift the feature exists to catch.

### Check-mode failure conditions and diff output

`--check` exits 1 if, for any template that has a `payload.json`:

- the rendered output differs from the committed `output.snap` (byte drift), or
- no `output.snap` is committed yet (a payload exists but its golden was never written).

On failure it prints, per offending template, the template name and a compact line-diff of
golden-vs-rendered, plus a one-line hint to run `meta prompt-snapshot` (write mode) to accept the change.
A clean run prints a one-line summary and exits 0.

### Exit codes (mirroring `meta verify`)

- No `metaobjects/` found → 2.
- Unresolved `@textRef`, a render error, or (in `--check`) any drift / missing golden → 1.
- Clean → 0.

### Relationship to `meta verify`

Independent and complementary commands; neither invokes the other. `verify` is the static field-drift
gate (template variable ↔ payload field tree); `prompt-snapshot` is the dynamic rendered-output gate. A
project runs both in CI.

## Cross-language strategy

TS-first, mirroring how the `@requiredTags` slice was delivered. The on-disk layout and command behavior
are the language-neutral contract; a later C# slice implements the identical command over the identical
layout. Because rendered output is already byte-identical across ports (guaranteed by the
`fixtures/render-conformance` corpus), the **same committed `output.snap` goldens are checkable by either
the TS or the C# `meta` CLI**, yielding the same verdict — the polyglot-portability payoff. Python and
Java are gated on first having a prompt-side `render()` (Python has only `verify` today; Java has no
render/verify tier), exactly as they are for the rest of FR-004.

## Testing (TDD)

Integration tests mirroring `cli/test/integration/verify.test.ts`, against a scaffolded temp project
(metaobjects + a prompts dir + `.metaobjects/snapshots/`):

- write mode renders a template that has a `payload.json` and creates its `output.snap`;
- `--check` passes clean immediately after a write;
- mutating the template text (or a shared partial) makes `--check` exit 1 and report the drift diff;
- a template without a `payload.json` is skipped (no golden written, no failure);
- `--check` against a payload-having template with no committed `output.snap` exits 1;
- missing `metaobjects/` exits 2; an unresolved `@textRef` exits 1.

Plus a focused test that a shared-partial edit is caught (the load-bearing case the template's own
history misses).

## Open questions / future slices

- **C# port** — implement the identical command over the identical layout; share the goldens.
- **Multiple payload cases per template** — the `<TemplateName>/` subdir already supports it; add when a
  consumer needs representative "empty / typical / large" payloads for one prompt.
- **Skeleton-payload scaffolding** — optionally, write mode could emit a placeholder `payload.json`
  derived from the `@payloadRef` field tree on first run, for the author to fill in. Deferred (adds
  scope; authors can write the fixture by hand).
