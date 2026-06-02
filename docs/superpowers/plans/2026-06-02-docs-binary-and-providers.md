# `meta docs` binary templates + config providers — implementation plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Close the two documented follow-ups from the neutral-metadata-docs feature so `meta docs` is a fully standalone Tier-2 capability:
1. Framework doc templates resolve inside the `bun --compile` `meta` binary (today they don't — only adopter-provided `templates/` work there).
2. `meta docs` loads `metaobjects.config.ts` providers so adopters with custom field/object types can generate docs.

**Architecture:** Both `codegen-ts` and `cli` build with `tsc` (the binary is built separately with `bun build --compile`). So embedding cannot use a `.mustache` text-import (tsc rejects it). Instead generate a plain-string module from the canonical `templates/`, imported by the framework provider with an on-disk-first / embedded-fallback chain. Config-provider loading mirrors `gen.ts`.

**Tech:** TypeScript, bun 1.3.8, tsc builds, the existing `render()`/`projectProvider` chain.

---

## Task 1: Embedded framework-template fallback (fixes binary)

**Intent:** `FrameworkTemplatesProvider` resolves the framework doc templates from the embedded map when the on-disk `templates/` dir is unavailable (the compiled binary). On-disk stays FIRST so dev/install layouts keep honoring local edits + adopter overrides.

**Files:**
- Create `scripts/generate-embedded-templates.ts` (bun script) — reads canonical `templates/docs/*.mustache`, writes `server/typescript/packages/codegen-ts/src/render-engine/embedded-templates.generated.ts` exporting `export const EMBEDDED_FRAMEWORK_TEMPLATES: Record<string, string> = { "docs/<name>.md": <content>, ... }` (key = the ref WITHOUT `.mustache`, matching how refs resolve; value = exact file text). Plain string literals only (tsc-safe). Header `// @generated from templates/docs/*.mustache — DO NOT EDIT; run scripts/generate-embedded-templates.ts`.
- Extend `scripts/sync-doc-templates.sh` to ALSO invoke the generator (so one command syncs the package copy AND regenerates the embedded module from canonical).
- Modify `server/typescript/packages/codegen-ts/src/render-engine/framework-provider.ts` — `FrameworkTemplatesProvider.resolve(ref)`: keep the on-disk lookup first; if it returns undefined, return `EMBEDDED_FRAMEWORK_TEMPLATES[ref]` (or undefined). Update the stale comment (lines ~33-35) that references a non-existent embedded fallback to describe the real one.
- Test: `server/typescript/packages/codegen-ts/test/embedded-templates.test.ts` — (a) GATE: every canonical `templates/docs/*.mustache` has a matching embedded entry whose content is byte-identical (prevents drift); (b) the embedded map covers exactly the canonical set (no missing/extra); (c) simulate the binary case: a `FrameworkTemplatesProvider` whose on-disk dir is unresolved still resolves `docs/entity-page.md` + `docs/template-page.md` from the embedded map.

- [ ] Step 1: Write `embedded-templates.test.ts` (drift gate + binary-fallback). Run → FAIL (generated module doesn't exist).
- [ ] Step 2: Write `scripts/generate-embedded-templates.ts`; run it to produce `embedded-templates.generated.ts`. Wire it into `sync-doc-templates.sh`.
- [ ] Step 3: Update `FrameworkTemplatesProvider.resolve` (on-disk → embedded fallback) + fix the stale comment.
- [ ] Step 4: Run → PASS the new test + `bun test packages/codegen-ts` (existing docs/golden/byte-identity gates unaffected — on-disk still wins in dev). Report counts.
- [ ] Step 5: Binary proof — `cd packages/cli && bun build ./bin/meta.ts --compile --outfile /tmp/meta-test --external @biomejs/wasm-bundler --external @biomejs/wasm-web`, then run `/tmp/meta-test docs <fixture-metadata> --out /tmp/docsout` from a dir with NO `templates/` and assert entity + template `.md` files are produced (framework templates now resolve from the embed). Report the result. (If building the full binary is too heavy/slow, at minimum assert the embedded provider resolves with on-disk forced-undefined — but attempt the real binary.)
- [ ] Step 6: Commit. `feat(codegen-ts): embed framework doc templates so they resolve in the compiled binary`

## Task 2: `meta docs` loads config providers (fixes custom types)

**Intent:** `meta docs` loads `metaobjects.config.ts` (best-effort) and passes `providers` to `loadMemory`, so adopters with custom field/object types can generate docs — mirroring `gen.ts`.

**Files:**
- Modify `server/typescript/packages/cli/src/commands/docs.ts` — before `loadMemory`, best-effort `loadMetaobjectsConfig(projectRoot)` (import from `../lib/load-metaobjects-config.js`, as gen.ts does); if it succeeds, pass `{ providers: forgeConfig.providers }` to `loadMemory` (guard undefined, exactly like `gen.ts:42-43`). If config loading fails/absent, proceed config-less (docs must still work with no config — do NOT hard-fail; gen treats config as required, docs must NOT).
- Test: `server/typescript/packages/cli/test/docs-command.test.ts` — add a case: a fixture project WITH a `metaobjects.config.ts` (or the config-loading mechanism) declaring a custom field/object type used in its metadata; `meta docs` loads + emits docs without a "type does not resolve" failure. Also keep/confirm the existing no-config case still works (config-less).

- [ ] Step 1: Write the custom-type-with-config docs test (mirror how gen's config tests set up `loadMetaobjectsConfig`/a fixture config). Run → FAIL (docs currently ignores providers → custom type fails to load).
- [ ] Step 2: Add best-effort config+providers loading to `docs.ts` (mirror gen.ts; non-fatal when absent).
- [ ] Step 3: Run → PASS the new test + the existing no-config docs tests + `bun test packages/cli`. Report counts.
- [ ] Step 4: Commit. `feat(cli): meta docs loads metaobjects.config.ts providers (custom types)`

## Task 3: Closeout
- [ ] Full suites: `bun test packages/codegen-ts packages/cli packages/render` green; counts.
- [ ] Hygiene (merge-base diff): no private names/home paths/node_modules/bunfig/lockfile/dist.
- [ ] Whole-branch code-review + simplifier; fix findings.
- [ ] Forward-merge to main, push, remove worktree, delete branch, update memory.

## Notes / guards
- The embedded module is a GENERATED artifact gated against canonical `templates/` — edit root templates, run `sync-doc-templates.sh` (now also regenerates the embed). Three representations (root canonical, package bundled copy, embedded module) all gated byte-identical.
- On-disk MUST stay first in `FrameworkTemplatesProvider` so adopter overrides + dev edits win; embedded is fallback only.
- Don't touch native code generators, the render engine, other ports, or doc neutrality. Public-repo hygiene.
