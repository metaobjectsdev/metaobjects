# Release documentation checklist

Every release MUST refresh the version/release references below. The library code
ships from `metaobjectsdev/metaobjects`, but **documentation and the public sites
live in three repos** and drift independently — a version bump is not "done" until
this whole list is walked.

Companion to [`RELEASING.md`](RELEASING.md) (npm/TS) and
[`RELEASING-java.md`](RELEASING-java.md) (Maven Central). Version lines: npm / NuGet /
PyPI track the `0.x` line; Maven Central (Java + Kotlin) tracks the `7.x` line.

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
- [ ] `docs/RELEASING.md` / `docs/RELEASING-java.md` / `.github/workflows/publish-*.yml`
      — the "currently `<ver>`" notes in the workflow-trigger comments.
- [ ] `agent-context/` — **NO version edits on a bump, by design.** The `meta init`
      LLM-context source is version-agnostic: Maven examples use
      `${metaobjects.version}` and there are no hardcoded npm versions. Only touch it
      when a *feature or API* changed (not a version number), and re-verify its
      accuracy when you do.

## B. The websites — separate sibling repos

### `metaobjectsdev/metaobjectsdev.github.io` → **metaobjects.dev** (GitHub Pages, content under `www/`)

- [ ] `www/llms.txt` — **mirror of this repo's `docs/llms/llms.txt`, maintained
      separately — keep the two in sync.** Same touch-points: "Shipping at …",
      `## Implementations (…)`, per-port lines, install snippets.
- [ ] `www/llms-full.txt` — mirror of this repo's `docs/llms/llms-full.txt`.
- [ ] `www/index.html` — the per-port status badges + descriptions
      (`npm 0.x · reference`, `Maven Central 7.x`, `NuGet 0.x`, `PyPI 0.x`).
- Deploys automatically via `.github/workflows/deploy.yml` on push to the default branch.

### `metaobjectsdev/metaobjects.com` → **metaobjects.com** (Eleventy → Cloudflare Pages)

- [ ] **Version-agnostic by design** — the marketing copy carries no version numbers,
      so a version bump needs **no change here**. Only revise on a *messaging* change.
- Build/deploy: `npm run deploy` (Eleventy build → `wrangler pages deploy dist`), or
  its `.github/workflows/deploy.yml`.

## Quick scan

From the release branch, grep the *previous* version to catch anything this list misses:

```bash
# this repo (metaobjects)
grep -rn "<previous-npm-version>\|<previous-maven-version>" README.md CHANGELOG.md CLAUDE.md docs/

# the metaobjects.dev site repo (sibling checkout)
grep -rn "<previous-npm-version>\|<previous-maven-version>" www/
```

Any hit outside `CHANGELOG.md` / historical `docs/superpowers/**` / `spec/decisions/**`
(which intentionally preserve old versions) is a doc that still needs revising.
