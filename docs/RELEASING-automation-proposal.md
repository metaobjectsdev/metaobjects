# Proposal: release automation — Changesets + OIDC Trusted Publishing

**Status:** proposal (not adopted). Companion to [`RELEASING.md`](RELEASING.md) (the
current manual procedure) and the `releasing` skill (the gated workflow over it).

## Current state (0.11.x)

Releases are a **manual full-lockstep** process: sed the version field across every
publish-candidate `package.json`, `rm bun.lock && bun install`, verify a packed
tarball, `bun publish` each in tier order with a **long-lived npm automation token**
(bypass-2FA) in `~/.npmrc`; RC-first to `next` → external smoke test → promote to
`latest` → tag → deprecate the RC. CHANGELOG and doc/website version refs are
hand-edited.

It works (and the `releasing` skill makes it repeatable), but: it's entirely
maintainer/agent-driven; the long-lived token is a standing supply-chain risk;
hand bumping + changelog is error-prone (cf. the broken 0.11.3 isolated patch); and
there's no per-PR record of what is releasable.

## Target state

1. **Changesets** for versioning + changelog.
   - Each PR adds a changeset file (`bunx changeset`) declaring bump level +
     human summary; a bot nags (non-blocking) if missing.
   - Configure a **`fixed` (lockstep) group** containing every publish candidate
     so they bump together — matching today's lockstep. `forge` / `conformance`
     (private) and the independently-versioned `*-angular` packages stay out.
   - A GitHub Action maintains a **"Version Packages" PR** that consumes changesets
     → bumps versions + writes `CHANGELOG.md`. **Merging that PR is the approval gate.**

2. **OIDC Trusted Publishing** for the publish itself.
   - Register a trusted publisher (per package) for the release workflow → short-lived
     OIDC token, **automatic provenance attestation, no `NPM_TOKEN` secret**.
   - Requires a cloud-hosted GitHub runner, npm CLI ≥ 11.5.1, Node ≥ 22.14.

3. **Keep the `releasing` skill's gates** as the human-judgment wrapper around the
   automation: preflight (CI-green-on-SHA, reviewed merge), RC + external smoke test,
   **STOP-before-promote**, docs/website propagation. Automation does the mechanics;
   the skill owns the judgment and the irreversible gate.

## Two integration risks to resolve first

- **OIDC can't drive `npm dist-tag`** (only `npm publish`). The RC→`next`→promote
  pattern needs `dist-tag`. Options: **(A)** publish RC via OIDC `publish --tag next`,
  promote with a short-lived token scoped to *only* the `dist-tag` step (keeps the
  immutable-`latest` safety net — **recommended**); **(B)** drop the dist-tag window,
  publish final straight to `latest` via OIDC with an in-workflow "install the packed
  tarball before publish" canary as the smoke gate (fully tokenless, but loses the
  published-but-not-`latest` RC window).

- **`workspace:*` rewriting.** We publish with `bun publish` precisely because it
  rewrites `workspace:*` to concrete versions; `npm publish` ships the literal string
  and breaks consumers. `changeset publish` uses npm/pnpm. Resolution: use Changesets
  only for **version + changelog** and keep **`bun publish`** for the actual publish,
  OR move the workspace to pnpm. Prove the rewrite on a throwaway RC before cutover —
  this is the main risk.

## Migration (incremental, low-risk)

1. Add `@changesets/cli` + config (`fixed` lockstep group, ignore private/angular). No behavior change.
2. Author changeset files per PR (habit) while still releasing manually.
3. Add the Version-Packages Action (opens the PR; does **not** publish yet).
4. Stand up the OIDC trusted publisher + a publish workflow behind `workflow_dispatch`,
   publishing to `next` only — validate provenance **and** the `workspace:*` rewrite on a throwaway RC.
5. When green: publish on Version-PR-merge; retire the manual sed/`bun.lock`/token steps
   from `RELEASING.md`. The skill's gates remain.

## Effort / payoff

~0.5–1 day to wire + validate (the `workspace:*` rewrite and OIDC provenance are the
things to prove). Low risk done incrementally — steps 1–3 are non-breaking; the publish
cutover stays gated behind `workflow_dispatch` + RC until proven. Payoff: no long-lived
token, automatic provenance, automated changelog + bump (kills the 0.11.3-class
incident), and per-PR release intent.

**Recommendation:** adopt steps 1–3 now (pure upside, no cutover); defer 4–5 until the
`workspace:*` + OIDC dry-run is proven. Keep the `releasing` skill as the wrapper either way.

## Sources

- Changesets: <https://github.com/changesets/changesets> · automating: <https://github.com/changesets/changesets/blob/main/docs/automating-changesets.md>
- npm Trusted Publishers (OIDC): <https://docs.npmjs.com/trusted-publishers/> · provenance: <https://docs.npmjs.com/generating-provenance-statements/>
- OIDC `dist-tag` gap: <https://github.com/orgs/community/discussions/176761>
- npm version immutability (why RC-first): <https://docs.npmjs.com/policies/unpublish/>
- Comparison of approaches: <https://oleksiipopov.com/blog/npm-release-automation/>
