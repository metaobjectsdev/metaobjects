# Unified docs door — one command, two surfaces, one config — design

**Date:** 2026-06-06
**Status:** Design (pending review)
**Relates to / supersedes:** ADR-0021 D1 (single docs door — extended from neutral-only to ALL docs),
ADR-0022 Part 3 (the docs boundary — api-docs is reframed as the *api surface* of the docs door, not a
standalone `meta gen` generator). Captured as a new **ADR-0025**. Builds on the shared `docs-paths.ts`
(`docPageHref`/`docPageOutputPath`) + `outputLayout` contract both doc producers already use.

## Goal

Make documentation ONE subsystem behind ONE per-port command (`meta docs` and its per-port siblings),
with ONE config block, producing one or more **surfaces** into one output tree, with **cross-links**
between them. Today the two doc producers are split across two producer models — neutral model docs are a
*command* (`meta docs`, ADR-0021 D1) while the SDK/API reference is a *generator* (`apiDocsFile()` in
`metaobjects.config.ts`, run via `meta gen`). Two producer models → two output configs → cross-linking
friction, and the asymmetry worsens as the api surface fans out per port.

## The core move

**Unify the user-facing layer (one door, one config, cross-links) while keeping the tiered engines
underneath.** The Tier-1/Tier-2 split does not disappear — it moves *inside* the docs subsystem as two
surfaces:

- **model surface** (today's neutral `meta docs` / `docsFile()`): language-INDEPENDENT output → stays
  **one shared engine** (Tier-2). Needs only metadata; honours the metadata-alone promise.
- **api surface** (today's `api-docs` / `apiDocsFile()`): idiomatic per language → stays **per-port**
  (Tier-1). Needs the gen config, because it documents what the codegen produced.

This satisfies the two adopter pains (one config; trivial cross-linking) WITHOUT reimplementing the
neutral docs in five languages (the Tier-2 trap).

## Scope

- **Build now: TypeScript only** — where both surfaces already exist. The `docs:` config schema, the
  surface model, and the cross-link path contract are designed as the **cross-port contract** so the
  other four ports adopt them when the api surface fans out.
- **Per-port door (designed, not all built):** `docs` is a command on each port's existing CLI, exactly
  like `gen`/`verify`/`agent-docs`: `meta docs` (TS), `dotnet meta docs` (C#), `metaobjects docs`
  (Python), `metaobjects:docs` Maven goal (Java/Kotlin). The command is per-language; the **model
  engine stays singular and shared** (each port invokes/embeds it), the **api engine is per-port**.
- **Out of scope (named, deferred to fan-out):** the mechanism by which a non-TS port reaches the shared
  model engine (embed a compiled binary vs. invoke the TS CLI vs. a thin port-native model-page emitter
  over the shared canonical templates). Decided when the api surface fans out — NOT in this effort.
- **Not in scope:** changing the model/api page *content* beyond adding the cross-link section; the
  render `verify()` engine; the rich-view renderer.

## Design

### 1. One door — `meta docs`

`meta docs` is the single producer of all docs. Behaviour:

- Loads metadata (always) and, if present, `metaobjects.config.ts` (for providers AND the generator set
  — it already loads the config for providers today).
- Emits the **model** surface ALWAYS (metadata-alone capable; works with zero config).
- Emits the **api** surface WHEN the gen config is present and `api` ∈ resolved surfaces. With no config
  / no generators, the api surface is skipped and a single friendly note is printed
  (`api docs skipped: no metaobjects.config.ts / generators found`).
- Flags (override the `docs:` config): `--model` / `--api` (select one; default both), `--out <dir>`,
  `--layout flat|package`, `--base-url <url>`.
- Writes everything under ONE `outDir`:
  - model pages: `<outDir>/<Entity>.md`, `<outDir>/<Template>.md`
  - api pages:   `<outDir>/api/<Entity>.md`, `<outDir>/api/AGENT-API.md`
  - ONE unified landing index `<outDir>/README.md` that links the model pages AND an "API reference"
    section linking the api pages. (The api surface's own `api/README.md` may remain as a sub-index.)

### 2. One `docs:` config block

In `metaobjects.config.ts`:

```ts
docs: {
  outDir:   "./docs",            // root for ALL surfaces
  layout:   "flat" | "package",  // shared page placement (defaults to config.outputLayout)
  baseUrl:  "",                  // optional; for an external docs site (absolute links)
  surfaces: ["model", "api"],    // which to emit; default both
  api: {                         // api-surface options, migrated verbatim from apiDocsFile()'s opts
    subDir: "api",               // api pages under <outDir>/<subDir>/ (current behaviour preserved)
    includeHonoRoutes: false,
    agentFile: true,             // emit AGENT-API.md
    // …remaining apiDocsFile options
  },
  // model: { … }  // reserved for future model-surface options
}
```

- CLI flags override the config block. Absent `docs:` block → defaults (`outDir ./docs`, layout from
  `config.outputLayout`, both surfaces when a config/generators exist else model-only).
- `layout` consolidates onto the existing `outputLayout` semantics (no second placement knob); the
  `docs.layout` value, when set, is the docs placement, defaulting to `config.outputLayout`.

### 3. Cross-links between surfaces (the payoff)

- Each **model** entity/template page gains an "API reference" link to its api page.
- Each **api** entity page gains a "Model / metadata" link back to its model page; template render
  helpers link back to the template's model page.
- All hrefs computed via the `docPageHref(layout, fromNode, toNode)` both surfaces ALREADY share, with
  the api `subDir` folded in — so links resolve in BOTH flat and package layouts (the exact mechanism
  hardened in the 2026-06-05 package-layout fix).
- The unified `README.md` cross-references both surfaces.

### 4. api-docs demoted (mirrors how `docsFile()` was deprecated)

- `apiDocsFile()` stays an exported engine but is `@deprecated` for `meta gen` config use — it becomes
  the INTERNAL engine of the docs door's api surface, exactly as `docsFile()` is the internal engine of
  the model surface (ADR-0021 D1).
- `meta init` scaffold: REMOVE `apiDocsFile()` from the `generators` array; ADD a `docs:` config block.
  `meta docs` is already in the next-steps block.
- Back-compat shim: if `apiDocsFile()` (or `docsFile()`) appears in a `metaobjects.config.ts`
  `generators` array, `meta gen` warns (`docs are produced by 'meta docs'; remove apiDocsFile() from
  generators`) and skips it (does not emit, to avoid a divergent second output path). One-release
  deprecation note; no silent behaviour.
- Guard test: the scaffold `generators` array contains NEITHER `docsFile` NOR `apiDocsFile`; a `docs:`
  block is present; `nextStepsBlock()` mentions `meta docs`.

### 5. The 5-port contract (designed now)

- The `docs:` config schema, the surface names (`model`, `api`), the output-tree layout
  (`<outDir>/` model + `<outDir>/api/` api + unified `README.md`), and the cross-link path contract
  (via shared `docs-paths` semantics) are the cross-port contract documented in ADR-0025.
- Each port will expose a `docs` command that emits its **api** surface natively (Tier-1, per-port) and
  the **model** surface via the ONE shared engine (Tier-2). The model surface output is byte-identical
  cross-port and will be conformance-gated (as agent-context/registry already are).
- **Open decision flagged in ADR-0025 (deferred):** how a non-TS port obtains the model surface —
  (a) embed a compiled model-docs binary (precedent: the `bun --compile` template/migrate binaries),
  (b) invoke the TS CLI as a build tool, or (c) a thin port-native model-page emitter driving the shared
  canonical `templates/docs/` (precedent: per-port codegen over shared neutral templates + a byte
  identity gate). Not chosen here.

### 6. ADR-0025

New `spec/decisions/ADR-0025-unified-docs-door.md`: docs is ONE subsystem, ONE per-port command door,
ONE `docs:` config, with N surfaces (`model` Tier-2 shared / `api` Tier-1 per-port) cross-linked in one
output tree. Marks ADR-0021 D1 extended (single door now covers all docs) and ADR-0022 Part 3 revised
(api-docs = the api surface of the door, not a standalone generator) with pointer links. Records the
deferred non-TS model-engine-reach decision as the key open item for the fan-out.

## File structure (TS)

- `server/typescript/packages/cli/src/commands/docs.ts` — the unified door: resolve the `docs:` config +
  CLI flags, emit the model surface (via `docsFile()`), emit the api surface (via `apiDocsFile()`) when
  config/generators present, write the unified index, wire cross-links.
- `server/typescript/packages/cli/src/lib/` (or sdk config schema) — extend the config type/schema with
  the `docs:` block.
- `server/typescript/packages/codegen-ts/src/generators/api-docs-file.ts` + `docs-file.ts` — accept the
  cross-link inputs (the sibling surface's presence + `docPageHref` targets) so each surface can emit the
  link to the other; mark `apiDocsFile()` `@deprecated` for `meta gen` (as `docsFile()` is).
- `server/typescript/packages/codegen-ts/src/generators/index.ts` — `@deprecated` note on the
  `apiDocsFile` re-export (mirroring `docsFile`).
- `server/typescript/packages/cli/src/commands/init.ts` — scaffold: drop `apiDocsFile()` from generators,
  add the `docs:` block; `meta gen` runner warns + skips a deprecated doc generator if present.
- Canonical `templates/docs/` — add the cross-link section to entity/template/api page templates
  (byte-identity-gated + synced as today).
- `spec/decisions/ADR-0025-unified-docs-door.md` — the ADR.
- Tests: cross-link integrity conformance gate (both directions, flat + package); unified-config parsing;
  `meta docs` with/without config (api graceful-degrade); scaffold guard test; deprecation-shim warning
  test; byte-stability of page content except the added cross-link section (goldens updated once).

## Testing / accuracy gates

- **Cross-link integrity:** every emitted cross-link (model→api and api→model) resolves to a real
  emitted page in the same run, in both flat and package layouts (extends the existing template-source
  link-integrity gate pattern).
- **Config resolution:** `docs:` block + CLI overrides resolve as specified; absent block → documented
  defaults; absent config → model-only + the note.
- **Deprecation shim:** a config still listing `apiDocsFile()`/`docsFile()` triggers the warning and the
  generator is skipped (no double output path).
- **Scaffold guard:** generators array free of both doc generators; `docs:` block present.
- **Byte-stability:** model + api page content unchanged except the cross-link section; goldens updated
  exactly once with that diff.

## YAGNI / non-goals

- No per-language model-docs reimplementation now (or ever, if avoidable) — the model engine is shared.
- No building the other four ports' `docs` command in this effort (contract only).
- No `docs.model` options beyond the reserved slot (none needed yet).
- No change to what the surfaces document, only how they're invoked, configured, and cross-linked.
