---
name: releasing
description: Use when cutting or publishing a release of the @metaobjectsdev npm/TypeScript packages — e.g. "do a release", "release 0.x.y", bumping the published npm version, promoting merged work to npm latest, or refreshing version references after a release.
---

# Releasing the npm/TypeScript packages

Orchestrate a full-lockstep release of the `@metaobjectsdev/*` npm packages: gate
on readiness, build, publish a release candidate, smoke-test, **stop for human
confirmation**, promote to `latest`, tag, then propagate versions to docs + the
websites.

**Core principle:** evidence before every step; **npm versions are immutable**, so
the promote-to-`latest` step is irreversible and human-gated. Every phase is
idempotent — check "is this already done?" before doing it (a half-finished
release must be re-runnable without double-publishing or double-tagging).

**The mechanics live in [`docs/RELEASING.md`](../../../docs/RELEASING.md) (golden
rules, tier order, auth) and
[`docs/RELEASING-docs-checklist.md`](../../../docs/RELEASING-docs-checklist.md)
(every doc/site to refresh).** This skill is the *gated workflow* over them — read
both before publishing.

## When to use
- "Do a release", "ship 0.11.6", "publish to npm", "bump the published version".
- After a release-bound change is **merged to `main`** and you intend to publish it.
- Not for: committing/merging code (that's done first — release runs on merged `main`).

## Phase 0 — Preflight gate (ALL must pass; show the evidence)

Do not bump or publish anything until every check is green. Print each result.

| Check | Command | Pass condition |
|---|---|---|
| On `main`, synced | `git rev-parse --abbrev-ref HEAD`; `git fetch && git status -sb` | on `main`, `up to date with origin/main` |
| Clean tree | `git status --short` | no uncommitted **release-relevant** changes (an unrelated untracked file is fine; uncommitted source/version edits are not) |
| Work is **merged via a reviewed PR** | `gh pr list --state merged --base main --limit 5`; `gh pr view <#> --json reviews,mergedAt` | the release-bound PR is merged AND has a review/approval (or you explicitly note none was requested) |
| **CI green on the exact release SHA** | `gh run list --branch main --limit 5`; `gh pr checks <#>` | all required checks `pass` on `HEAD` — not "passed sometime" |
| Published vs local version | `npm view @metaobjectsdev/cli dist-tags.latest`; compare to `package.json` | you know current `latest` and the target bump |
| **Target version is free** | `npm view @metaobjectsdev/cli@<version> version` (a 404 = free); `git tag -l v<version>` | the target version is NOT already published or tagged (npm versions are permanent — a taken version can never be reused) |
| CHANGELOG ready | `sed -n '1,20p' CHANGELOG.md` | an entry exists or you will add one (see Phase 8) |
| **`metamodelVersion` moved if the metamodel did** | `node scripts/check-metamodel-version.mjs` | exit 0. It diffs `expected-registry.json` against the last release tag and fails if the vocabulary changed without the version moving. Read its PROSE warning too — a rule can change with no machine-readable footprint (#210 changed only a `rules` string). Fix with `--set <version>`; detail with `--explain`. |

If the code-review check fails (no PR, or unmerged/dirty tree): **stop** — releases
ship reviewed, merged `main`, never a working tree.

**"It builds and `bun test` is green on my branch" is NOT the release bar.** The
in-workspace test suite structurally cannot catch the failures that matter for an
npm publish — a `devDependency` that should be a runtime `dependency` (present
in-workspace, so the test passes; only a clean external install fails), the stale
`bun.lock` sibling-pinning bug, or pnpm-strict resolution bugs. Local green tells
you nothing about whether the *published artifact* installs. That is what the RC +
external smoke test (Phases 4–5) exist to prove. Do not let urgency skip them.

### Two numbers, two contracts

**The package version and `metamodelVersion` answer different questions, and a release
may move either, both, or neither** (ADR-0035 Amendment 2):

- **package version** — did the SOFTWARE surface change? (exports, CLI flags,
  generated-code shape). This is what you publish.
- **`metamodelVersion`** — did the METADATA contract change? (registered vocabulary,
  canonical/interchange format, wire contract). A breaking metamodel change moves ITS
  major and **does not** force a package major.

Post-1.0 the caret rule no longer gates the metadata axis (`^1.0.0` accepts `1.1.0`), so
**a release that moves `metamodelVersion` must say so in the CHANGELOG** — that line is
the adopter's only signal. Bump with `node scripts/check-metamodel-version.mjs --set
<version>`, which writes all five declaring sites at once; a port left behind fails
`registry-conformance`, but only in that port's lane.

## Phase 1 — Decide scope + version

The lockstep set = every package currently at the previous version (it is NOT a
fixed list; `ai-runtime` and the `client/web/packages/*` are in it). Enumerate it:

```bash
for f in server/typescript/packages/*/package.json client/web/packages/*/package.json; do
  node -e "const p=require('./$f'); if(p.version==='<PREV>'&&!p.private) console.log(p.version,p.name)"
done
```

`forge` / `conformance` are `private` (never publish). Confirm each candidate is
actually on npm (`npm view <pkg> dist-tags`). Patch bump unless a public API
changed; this repo bumps the whole set in lockstep (pre-1.0).

**Registry vocabulary does not force a MINOR** — a new *attribute* is a PATCH, a new
top-level *type* is a MINOR, and a new *subtype* is a PATCH when inert. See
`docs/RELEASING.md` → "The vocabulary rule" before choosing the level; the old
"any registry addition ⇒ MINOR" reading spent two minors on changes no adopter
could observe.

## Phase 2 — Build fresh (the stale-`dist` trap)

`dist/` is gitignored, `bun publish` does NOT rebuild, and `main` points at `dist/`
— a stale `dist` ships code *without* your change. `tsc` also leaves orphaned `.js`
for deleted sources, so **clean-rebuild**:

```bash
bun run clean && bun run build
```

Then spot-check `dist` reflects the change (a deleted file is gone, new code present).

## Phase 3 — RC version + lockfile + packed-deps verify

```bash
# bump the lockstep set to <version>-rc.1 (sed the "version" field of each)
rm bun.lock && bun install        # CRITICAL: re-pins workspace:* from the lockfile, not package.json
# verify a packed tarball pins siblings to the RC (catches the stale-lockfile bug):
( cd server/typescript/packages/cli && bun pm pack --destination /tmp/p )
tar -xzOf /tmp/p/*.tgz package/package.json | grep '@metaobjectsdev'   # must show <version>-rc.1, no workspace:*
```

## Phase 4 — Publish RC to `next`

Publish each in **tier order** (deps before dependents; see RELEASING.md), leaf
packages last: `( cd <pkg> && bun publish --tag=next )`. RC does not move `latest`.

## Phase 5 — External smoke test (npm AND pnpm)

In throwaway dirs, install the published RC and exercise it — pnpm's strict
`node_modules` catches resolution bugs npm hides:

```bash
npm i @metaobjectsdev/cli@next && npx meta --version && npx meta init && npx meta gen
pnpm add @metaobjectsdev/cli@next && pnpm exec meta --version
```

`meta --version` must report the RC. Any module-resolution error = a misclassified
dep; fix, bump `-rc.2`, repeat.

## Phase 6 — STOP. Confirm before promoting.

Promoting to `latest` is **irreversible** (npm versions are permanent — no reuse
even after unpublish). Summarize the evidence (CI SHA, packed deps, smoke results)
and get explicit human confirmation before Phase 7. Do not auto-promote.

## Phase 7 — Promote to `latest`

Bump the set `-rc.N` → final `<version>`, `rm bun.lock && bun install`, re-verify
packed deps = `<version>`, commit `chore(release): <version>`, then
`( cd <pkg> && bun publish )` in tier order.

## Phase 8 — Tag + GitHub release + changelog

```bash
git push origin main && git tag v<version> && git push origin v<version>
```
Add the `CHANGELOG.md` entry (Keep-a-Changelog format) if not already committed.

## Phase 9 — Cleanup

`npm dist-tag rm <pkg> next` and `npm deprecate <pkg>@<version>-rc.1 "superseded; use <version>"` for each package.

## Phase 10 — Propagate versions (docs + websites)

Walk [`docs/RELEASING-docs-checklist.md`](../../../docs/RELEASING-docs-checklist.md).
**npm-only edits** — the npm line bumps; NuGet/PyPI and Maven Central are *different
ports on different version lines* and must NOT change:
- This repo: `CHANGELOG.md`, `CLAUDE.md` Status, `README.md`, `docs/llms/llms.txt`,
  `docs/llms/llms-full.txt`, `docs/ports/typescript.md`.
- Site repo `metaobjectsdev.github.io` (→ metaobjects.dev): `www/index.html`,
  `www/llms.txt`, `www/llms-full.txt`. **Pushing deploys the live site** — confirm first.
- `metaobjects.com` is version-agnostic — no change.

Audit: `git grep -nE "0\.11\.1\b"` — every remaining old-npm hit must be a
NuGet/PyPI/C#/Python reference, never npm.

## Phase 11 — Verify the published release

`npm dist-tag ls <pkg>` (authoritative; `npm view` is CDN-cached) shows
`latest: <version>`. A clean external `npm i @metaobjectsdev/cli` → `meta --version`
reports `<version>`. Live site serves the new version (`curl metaobjects.dev/llms.txt`).

## Idempotency / resuming a half-done release
Before each action, check state: already-published version (`npm view`), tag exists
(`git tag -l`), dist-tag present (`npm dist-tag ls`). Re-publishing an existing npm
version FAILS by design — skip what's done, never force.

## Common mistakes
- **Shipping stale `dist`** — forgot `bun run clean && bun run build`; the tarball lacks your change.
- **Not regenerating `bun.lock`** after a version bump — siblings publish pinned to the *previous* version (uninstallable). Always `rm bun.lock && bun install`, then verify the packed tarball.
- **`npm publish` instead of `bun publish`** — ships the literal `workspace:*`, breaking every consumer.
- **Bumping NuGet/PyPI/Maven** version refs in docs — those are separate release lines; npm-only.
- **Trusting "CI is green"** without checking it's green on the *release SHA*.
- **Auto-promoting to `latest`** — it's immutable; always stop-and-confirm (Phase 6).
- **A changed golden/snapshot file is not "just regenerate"** — if generated output changed, prove the new output is correct (run the real conformance scenario) BEFORE regenerating the committed artifact.

## Red flags — STOP
- Working tree dirty (release-relevant), or the change isn't merged to `main` → not releasable yet.
- "It builds and `bun test` is green on my branch, just publish it" → local green ≠ releasable; the work must be merged + CI-green on the release SHA + RC-smoke-tested first.
- A required check is `pending`/`fail` on `HEAD` → wait/fix, don't override.
- Urgency pressure pushing you to skip the RC + npm/pnpm smoke test (Phases 4–5) → those are exactly what protect an immutable `latest`; never collapse them.
- About to `bun publish` to `latest` without human confirmation → stop.
- About to push the site repo without confirming the live deploy → stop.

## Future improvement (research-backed, not yet adopted)
Best practice for npm/TS monorepos is **Changesets** (per-PR intent files → a
reviewable "Version Packages" PR → automated bump + CHANGELOG) on a GitHub Action,
plus **OIDC Trusted Publishing** (short-lived tokens + automatic provenance, no
long-lived `NPM_TOKEN`). Caveat: OIDC can't drive `npm dist-tag` yet, so RC→promote
still needs a token. Adopting these would replace Phases 1/3/7/9's manual steps;
the preflight gate, smoke test, and stop-and-confirm in this skill stay.
