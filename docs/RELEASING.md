# Releasing the TypeScript packages to npm

How to publish the `@metaobjectsdev/*` TypeScript packages. Read the **Golden rules** first —
each one cost a broken/burned release to learn.

## What gets published

The 12 publish-candidate packages (versioned in lockstep unless a package gets an isolated patch):

| Tier | Packages |
|---|---|
| 0 | `metadata`, `render` |
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

### 2b. Cross-language persistence conformance (on-demand)

Before promoting to `latest`, run the cross-language persistence suite against real Postgres
(spins up one ephemeral testcontainer per scenario, exercises each port's codegen + runtime
end-to-end). It is **not** part of `bun test` / `dotnet test` because it requires a docker daemon:

```bash
scripts/integration-test.sh           # all runners (typescript + c# + java)
scripts/integration-test.sh ts        # just typescript
scripts/integration-test.sh csharp    # just c#
scripts/integration-test.sh java      # just java
```

The corpus lives at [`fixtures/persistence-conformance/`](../fixtures/persistence-conformance/).
A red run here has caught real cross-port divergence (view-DDL identifier quoting, column-naming
strategy mismatches) that the unit suites missed.

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

# Releasing the C# packages to NuGet

How to publish the `MetaObjects*` C# packages to nuget.org. We use **Trusted Publishing**
(OIDC from GitHub Actions) — **no long-lived API key, no signing certificate**. Read the
**Gotchas** first.

## What gets published

Four packages, version-locked at the C# port version (currently `0.9.0`):

| Package | Contents |
|---|---|
| `MetaObjects` | Loader + canonical serializer |
| `MetaObjects.Render` | Mustache render + payload-VO + `verify` |
| `MetaObjects.Codegen` | EF Core + ASP.NET codegen + the runtime filter/dispatch helpers generated code references |
| `MetaObjects.Cli` | The `dotnet meta` .NET tool (`gen` / `verify` / `agent-docs`) |

Shared package metadata lives in [`server/csharp/Directory.Build.props`](../server/csharp/Directory.Build.props);
per-package `PackageId`/`Title`/`Description` live in each `.csproj`. Test/integration projects set
`IsPackable=false` and never publish. There are no inter-package version-rewrite concerns like npm's
`workspace:*` — `ProjectReference`s become NuGet dependencies pinned to the same `Version`.

## How we publish: Trusted Publishing (OIDC)

The workflow [`.github/workflows/publish-csharp.yml`](../.github/workflows/publish-csharp.yml) packs
the four projects, exchanges a GitHub OIDC token for a short-lived (~1 hour) nuget.org key via
`NuGet/login@v1`, then `dotnet nuget push`es. Trigger it manually (**Actions → publish-csharp → Run
workflow**, with an optional version override) or by pushing a `csharp-v*` tag.

### One-time nuget.org setup

Create a Trusted Publishing policy (nuget.org → your username → **Trusted Publishing** → **Create**).
For this repo (`github.com/metaobjectsdev/metaobjects`) enter **exactly**:

| Field | Value |
|---|---|
| Policy Name | `metaobjects-csharp-publish` (any name) |
| Package Owner | `metaobjects` (the org) |
| Repository Owner | `metaobjectsdev` |
| Repository | `metaobjects` |
| Workflow File | `publish-csharp.yml` *(filename only — not the `.github/workflows/` path)* |
| Environment | *(leave empty)* |

Then add a GitHub repo secret (**Settings → Secrets and variables → Actions**):

| Secret | Value |
|---|---|
| `NUGET_USER` | Your nuget.org **username** (the profile name at `nuget.org/profiles/<username>`) — **NOT** your `doug@dougmealing.com` login email |

Because this repo is **public**, the policy activates immediately. (The "pending for 7 days" status
the nuget.org docs mention only applies to *private* repos, where NuGet waits for a first publish to
lock the repo/owner IDs against resurrection attacks.)

## Gotchas (the non-obvious ones)

1. **`NuGet/login`'s `user:` is the nuget.org username (profile name), never the email.** Email
   silently fails the token exchange. We pass it via the `NUGET_USER` secret.
2. **NuGet versions are immutable** (like npm). You cannot re-push a version — only *unlist* or
   *deprecate*. So validate the packed `.nupkg` locally before triggering the workflow.
3. **Bump the version in `Directory.Build.props`** (`<Version>`), not per-project. The
   workflow can also override per-run via the `version` dispatch input (`-p:Version=`).
4. **Don't re-add `Pack`/`PackagePath` to the CLI's `agent-context/` Content item.** `PackAsTool`
   already bundles build output (the files arrive via `CopyToOutputDirectory`) into
   `tools/net8.0/any/`; an explicit `PackagePath` double-adds every file → **NU5118**, which is
   fatal under this repo's `TreatWarningsAsErrors`. The item is deliberately `Pack=false`.
5. **The temp key is single-use and ~1 h.** The workflow requests it immediately before push — don't
   move the `NuGet/login` step earlier.
6. **The policy is bound to the org + repo + workflow *filename*.** Renaming `publish-csharp.yml`, or
   the policy owner leaving/locking the `metaobjects` org, makes the policy inactive until fixed.
7. **Source Link + symbols are on** (`PublishRepositoryUrl`, `EmbedUntrackedSources`, `snupkg`); CI
   sets `ContinuousIntegrationBuild` for deterministic builds. No action needed — just don't strip them.

## Procedure

1. **Pick the publish commit on `main`** (a stable, merged tip — not a mid-refactor branch). Ensure
   the packaging config + `publish-csharp.yml` are on it. Set `<Version>` in `Directory.Build.props`.
2. **Validate locally** (catches immutable-version mistakes before they're permanent):
   ```bash
   cd server/csharp
   dotnet pack MetaObjects/MetaObjects.csproj MetaObjects.Render/MetaObjects.Render.csproj \
     MetaObjects.Codegen/MetaObjects.Codegen.csproj MetaObjects.Cli/MetaObjects.Cli.csproj \
     -c Release -o /tmp/mo-nupkg
   # inspect a nuspec — version, license, readme, deps:
   unzip -p /tmp/mo-nupkg/MetaObjects.Render.0.9.0.nupkg MetaObjects.Render.nuspec | grep -iE '<id>|<version>|<license|<readme>|<dependenc'
   # optional: install the tool from the local dir and smoke-test it
   dotnet tool install --global --add-source /tmp/mo-nupkg MetaObjects.Cli && dotnet meta --help
   ```
3. **Run persistence conformance** if the runtime/codegen changed: `scripts/integration-test.sh csharp`.
4. **Publish:** GitHub → **Actions → publish-csharp → Run workflow** (or push a `csharp-v<version>` tag).
5. **Verify** on nuget.org: all four packages listed and **owned by the `metaobjects` org**
   (indexing/validation takes a few minutes).

## Other language ecosystems (Java / Python)

This guide is **TypeScript / npm-specific** — its gotchas (`workspace:*`, `bun publish`, lockfile
re-pinning) do not transfer. Each language ships through a different registry with its own tooling,
auth, signing, and failure modes, so **each gets its own release guide, written when it does its
first real release** — like this one. The npm rules above were only learned by actually publishing;
don't pre-write speculative procedures for ecosystems that aren't shipping yet.

What to expect per ecosystem:

| Language | Registry | Tooling | Gotchas to anticipate |
|---|---|---|---|
| Java | Maven Central (Sonatype Central Portal) | `mvn deploy` / Gradle publish | GPG-signed artifacts; `groupId` ownership verification; staging → release promotion; javadoc + sources jars required |
| Python | PyPI | `uv build` / `python -m build` + `twine` | sdist + wheel; `pyproject.toml` metadata; prefer **OIDC trusted publishing** over long-lived tokens |

(C# now has its own guide above — *Releasing the C# packages to NuGet*.)

**Versions are not unified across languages** — TS and C# are on the `0.9.x` line, the Java/Kotlin
module line is on the `7.2.x` track. Don't force one number. The cross-language contract
is the **conformance corpus + [`fixtures/conformance/CAPABILITIES.json`](../fixtures/conformance/CAPABILITIES.json)**:
each release states which capabilities/conformance level it satisfies, and *that* manifest — not a
shared version — is the coordination point. (Generated code runs without any MetaObjects runtime, so
a language only publishes the libraries it actually ships: runtime helpers, and codegen where it exists.)

## Public-repo hygiene

This repo is public. Before committing release changes, ensure no local paths or private/consumer
names leak (the `.githooks/pre-commit` guard enforces this — activate with
`git config core.hooksPath .githooks`). See [CLAUDE.md](../CLAUDE.md) → *Public repository hygiene*.
