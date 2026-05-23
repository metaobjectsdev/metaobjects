# Releasing the TypeScript packages to npm

How to publish the `@metaobjectsdev/*` TypeScript packages. Read the **Golden rules** first —
each one cost a broken/burned release to learn.

## What gets published

The 11 publish-candidate packages (versioned in lockstep unless a package gets an isolated patch):

| Tier | Packages |
|---|---|
| 0 | `metadata` |
| 1 | `codegen-ts`, `runtime-ts`, `migrate-ts`, `sdk`, `runtime-web` |
| 2 | `codegen-ts-react`, `codegen-ts-tanstack`, `react` |
| 3 | `tanstack` |
| 4 | `cli` |

Publish in tier order so a dependent never lands before its dependency. **`forge` and
`conformance` are `private: true` and must never be published** (bun refuses them).

## Golden rules (the non-obvious ones)

1. **Publish with `bun publish`, never `npm publish`.** The packages depend on each other via
   `workspace:*`; only bun rewrites that to the concrete version in the published tarball. `npm
   publish` ships the literal string `"workspace:*"` and breaks every consumer.

2. **After ANY version bump, regenerate the lockfile: `rm bun.lock && bun install`.** `bun publish`
   resolves `workspace:*` from `bun.lock`, *not* the live `package.json`. A plain `bun install`
   reports "no changes" and keeps the **stale** member versions — so packages publish with sibling
   deps pinned to the *previous* version (uninstallable). Then **verify** by inspecting a packed
   tarball, not just that it packs:
   ```bash
   cd server/typescript/packages/cli && bun pm pack --destination /tmp/p
   tar -xzOf /tmp/p/*.tgz package/package.json | grep '@metaobjectsdev'   # must show the version you're releasing
   ```

3. **Runtime imports must be `dependencies`, not `devDependencies`.** The in-workspace test suite
   can't catch a misclassified dep (devDeps are installed there). Only a clean external install does.

4. **Always smoke-test a real external install before promoting to `latest`** — in **both npm and
   pnpm** (pnpm's strict, non-nested `node_modules` exposes resolution bugs npm/bun hide). Install
   the cli into a throwaway dir, run `meta --version`, `meta init`, `meta gen`.

5. **npm versions are immutable.** You can never re-publish a version, and unpublish is a
   restricted 72-hour escape hatch. That's why we go RC-first.

## Prerequisites

- The JS/TS **workspace root is the repo root** (`/package.json`), globbing
  `server/typescript/packages/*` + `client/web/packages/*`. This is what makes `workspace:*`
  resolve uniformly at publish time — don't move it.
- npm auth as an owner of the `metaobjectsdev` org. The account has 2FA **auth-and-writes**, so for
  an unattended publish use a **Granular/Automation token with the bypass-2FA option**, scoped
  read+write to `@metaobjectsdev`, in `~/.npmrc` (`//registry.npmjs.org/:_authToken=...`). Revoke
  it after the release. (Without it, every `bun publish` prompts for an OTP.)
- `bun publish` does **not** apply `publishConfig` field overrides (bin/main/exports) — only
  `access`/`tag` (oven-sh/bun#19205). So fields like `bin` must be correct at the top level, not
  swapped via `publishConfig`.

## Procedure

Run everything from the repo root unless noted. Bump the 11 publish-candidate versions only (not
the private root, not forge/conformance).

### 1. Release candidate → `next`
```bash
# bump the 11 to <version>-rc.N (sed the "version" field in each publish-candidate package.json)
rm bun.lock && bun install                       # CRITICAL — re-pins workspace versions
# verify a packed tarball's deps show <version>-rc.N (rule 2)
# publish each package in tier order:
( cd <pkg-dir> && bun publish --tag=next )
```
Note: the **first-ever** publish of a brand-new package name sets `latest` even with `--tag=next`;
move it after the smoke test (or accept it points at the RC until you promote).

### 2. Smoke-test the RC (rule 4)
```bash
cd $(mktemp -d) && npm init -y >/dev/null
npm i @metaobjectsdev/cli@next --prefer-online        # or pnpm in a pnpm project
npx meta --version && npx meta init && npx meta gen
```
Fix anything that surfaces, bump to `-rc.(N+1)`, repeat. (rc.1 missed the lockfile regen; rc.2
missed a runtime dep; rc.3 was clean — expect iterations.)

### 3. Promote to `latest`
```bash
# bump the 11 to the final <version>
rm bun.lock && bun install
# verify packed deps (rule 2); commit "chore(release): <version>"
( cd <pkg-dir> && bun publish )                  # default tag = latest, tier order
git tag v<version> && git push origin main --tags
```

### 4. Cleanup
```bash
# deprecate any broken/superseded RCs
npm deprecate '@metaobjectsdev/<pkg>@<bad-version>' "superseded; use <version>"
# point latest off a bad version if needed, and drop the now-stale next tag
npm dist-tag rm @metaobjectsdev/<pkg> next
```
Then verify the registry: `npm view @metaobjectsdev/<pkg> dist-tags` (or `curl` the registry to
bypass npm CLI cache, which lags right after publish).

## Isolated patch (one package)

If only one package changed (e.g. a `cli` bugfix), bump just that package, `rm bun.lock && bun
install`, verify, and `bun publish` it — the others stay at their current version. Tag scoped
(e.g. `cli-v0.5.1`).

## Public-repo hygiene

This repo is public. Before committing release changes, ensure no local paths or private/consumer
names leak (the `.githooks/pre-commit` guard enforces this — activate with
`git config core.hooksPath .githooks`). See [CLAUDE.md](../CLAUDE.md) → *Public repository hygiene*.
