# Release documentation checklist

Every release MUST refresh the version/release references below. The library code
ships from `metaobjectsdev/metaobjects`, but **documentation and the public sites
live in three repos** and drift independently — a version bump is not "done" until
this whole list is walked.

Companion to [`RELEASING.md`](RELEASING.md) (npm/TS) and
[`RELEASING-java.md`](RELEASING-java.md) (Maven Central). Two version lines, one release:
npm / NuGet / PyPI carry the shared number (`1.0.0` at the 1.0 cut) and Maven Central
carries the same `minor.patch` on **npm major + 7** (`8.0.0`). Do not hardcode either
major anywhere — the previous `0.x` / `7.x` spelling of this sentence outlived its truth
by exactly one release.

> **Tip:** the fastest way to not miss anything is to grep the *previous* version
> across each repo (see [Quick scan](#quick-scan)) — this list is the map, the grep
> is the safety net.

## A. This repo — `metaobjectsdev/metaobjects`

- [ ] `README.md` — per-port version rows (npm + Maven Central).
- [ ] `CHANGELOG.md` — add the release entry.
- [ ] `CLAUDE.md` — the `## Status` section (version line + "_Last refreshed_" date).
- [ ] `docs/llms/llms.txt` — the "Shipping at `<npm>` … and `<maven>` …" line, the
      `## Implementations (npm … / Maven Central …)` header, the per-port version
      lines, and the install snippets.
- [ ] `docs/llms/llms-full.txt` — same version touch-points as `llms.txt`.
- [ ] `docs/ports/typescript.md` — npm version + install snippet.
- [ ] `docs/ports/typescript-client.md` — npm version (if referenced).
- [ ] `docs/ports/csharp.md` — the `<PackageReference … Version="…"/>` snippets.
- [ ] `docs/ports/java.md` — Maven `<version>` + artifact list.
- [ ] `docs/ports/kotlin.md` — Maven `<version>`.
- [ ] `docs/ports/python.md` — PyPI version + `pip install`.
- [ ] `docs/features/extending-with-providers.md` — the "parity status as of `<ver>`" marker.
- [ ] `docs/RELEASING.md` / `docs/RELEASING-java.md` — the "currently `<ver>`" notes.
- [ ] `.github/workflows/publish-*.yml` — **no version edits by design.** All four
      publish workflows read the version from the committed manifest
      (`package.json` / pom / `Directory.Build.props` / `pyproject.toml`), so none
      hardcodes one. Re-check only if someone adds a version string back; the
      `publish-csharp.yml` `workflow_dispatch` description carried one until
      `0.21.6` and had silently drifted seven releases stale.
- [ ] `agent-context/` — **NO version edits on a bump, by design.** The `meta init`
      LLM-context source is version-agnostic: Maven examples use
      `${metaobjects.version}` and there are no hardcoded npm versions. Only touch it
      when a *feature or API* changed (not a version number), and re-verify its
      accuracy when you do.

## B. The websites — separate sibling repos

### `metaobjectsdev/metaobjectsdev.github.io` → **metaobjects.dev** (GitHub Pages, content under `www/`)

**Nothing on this list is a version edit any more, and that is the point** — every
version-bearing byte the site serves is copied or injected at deploy time from THIS repo,
pinned to the newest npm-line release tag. What the release owes the site is a **push**,
not an edit. Confirm rather than change:

- [ ] `www/llms.txt` / `www/llms-full.txt` — **gitignored there**, copied from this repo's
      `docs/llms/` at deploy. Fix them here (§A), never in the site repo.
- [ ] `www/assess.md` — **gitignored there**, copied from this repo's
      `agent-context/skills/metaobjects-fit-assessment/SKILL.md` (its body, from the first
      top-level heading) at deploy. Fix it here.
- [ ] `www/index.html` and every other page — the four registry coordinates plus
      `metamodel` are injected into any element carrying `data-registry="…"` from
      `examples/showcase/site-payload.json`. The numbers in the committed HTML are
      placeholders; editing them changes nothing that ships.
- [ ] **The tag pin resolves to the release you just cut.** `deploy.yml` walks the release
      tags newest-first and takes the one whose `server/typescript/packages/cli/package.json`
      is versioned as the tag — that is what identifies the npm line, since the legacy
      JVM-only `v7.x` tags still sort above it. Read the `pinned to metaobjects vX.Y.Z` line
      in the deploy log; a wrong pin publishes a stale site with every step green.
- [ ] Preview exactly what a deploy would render, without touching the site checkout:
      `bun run site:preview --site <site-repo>/www --strict`.
- Deploys automatically via `.github/workflows/deploy.yml` on push to the default branch.
  **A push IS a deploy** — there is no staging.

### `metaobjectsdev/metaobjects.com` → **metaobjects.com** (Eleventy → Cloudflare Pages)

- [ ] **Version-agnostic by design** — the marketing copy carries no version numbers,
      so a version bump needs **no change here**. Only revise on a *messaging* change.
- Build/deploy: `npm run deploy` (Eleventy build → `wrangler pages deploy dist`), or
  its `.github/workflows/deploy.yml`.

## Quick scan

From the release branch, grep the *previous* version to catch anything this list misses:

```bash
# this repo (metaobjects) — the only repo where a version is hand-written
grep -rn "<previous-npm-version>\|<previous-maven-version>" README.md CHANGELOG.md CLAUDE.md docs/

# the coordinates the site will serve — one file, five values
jq .registries examples/showcase/site-payload.json
```

Any hit outside `CHANGELOG.md` / historical `docs/superpowers/**` / `spec/decisions/**`
(which intentionally preserve old versions) is a doc that still needs revising.

**Do not grep the site repo's `www/`.** Its version numbers are placeholders and its
mirrors are gitignored build output, so that grep reports hits nobody should fix and
misses the one thing that can actually be wrong — which release tag the deploy pins to.
