# Releasing MetaObjects

> **Who runs releases: the agent (Claude) does — end to end, for every registry.** The
> credentials are on the maintainer's machine; there is no "hand it to the human to publish"
> step. Locations:
> - **npm** → `~/.npmrc` (automation token). Publish with `bun publish`.
> - **PyPI** → token in `~/Work/Keys/pypi.txt`. **Publish manually with `uv publish`** — the
>   OIDC Trusted Publishing workflow is misconfigured ([#36]), so the keyless path below does
>   NOT work yet; use the manual procedure.
> - **Maven Central** → `~/.m2/settings.xml` (server ids `central` + `gpg-credentials`) + the
>   local GPG signing key. `mvn -Prelease deploy` from `server/java` (autoPublish — no manual
>   staging promotion).
> - **NuGet** → keyless OIDC via the `publish-csharp.yml` workflow: `gh workflow run
>   publish-csharp.yml` (or push a `csharp-v<version>` tag).
>
> Run network commands via the sandbox-disabled shell. **Single shared patch number (standing
> policy since 0.20.13):** every release cuts ALL FOUR registries at the same `minor.patch` —
> npm / PyPI / NuGet on `0.<m>.<p>`, Maven on `7.<m>.<p>` (only the major differs, for historical
> continuity). A registry with no changed product file publishes a **version-parity bump**
> (identical content at the new version) rather than sitting the release out. The rest of this doc
> is the per-registry procedure.

## Step 0 (all registries): scan for unmerged work before you cut

Run this **first**, before the CHANGELOG is even written:

```bash
git fetch origin -q
for b in $(git branch -a --no-merged origin/main --format='%(refname)' | grep -v HEAD); do
  d=$(git log -1 --format=%ct "$b" 2>/dev/null); [ -z "$d" ] && continue
  age=$(( ( $(date +%s) - d ) / 86400 ))
  [ "$age" -le 14 ] && printf "%3sd  %s  %s\n" "$age" "$(git log -1 --format=%h "$b")" "${b#refs/}"
done | sort -n
```

The recency filter is load-bearing: a bare `git branch -a --no-merged` returns ~100 branches here
(abandoned spikes, `worktree-agent-*` artifacts, old release branches). A wall that size gets
skimmed, which defeats the check — so bound it to what could plausibly belong in this cut.

Decide explicitly for every branch the scan returns: merge it into this cut, or state why it waits.
Note that `no-mistakes/*` branches are usually gate replays of work already on `main` — confirm
rather than assume. Do not skip past the list.

**Why this is step 0 and not a nicety:** `0.21.1` shipped *without* a `timestampMode` fix that was
already written and sitting on an unmerged branch. Because versions are immutable on all four
registries, the only correction was a full coordinated `0.21.2` within the hour — four publishes, an
~11-minute Maven deploy, and a second round of adopter notification, to ship work that already
existed. The single shared patch number makes an omission cost four publishes, not one.

## Releasing the TypeScript packages to npm

How to publish the `@metaobjectsdev/*` TypeScript packages. Read the **Golden rules** first —
each one cost a broken/burned release to learn.

> **After any release, walk [`RELEASING-docs-checklist.md`](RELEASING-docs-checklist.md)** —
> it lists every doc + website (this repo, metaobjects.dev, metaobjects.com) whose version
> references must be refreshed. A version bump is not done until that list is walked.

## What gets published

The publish-candidate packages (versioned in lockstep unless a package gets an
isolated patch). **Enumerate the set each release — do not trust this count** (it
was **13** at 0.11.5); the lockstep set is "every non-`private` package at the
previous version" (a sed/grep over `*/package.json`):

| Tier | Packages |
|---|---|
| 0 | `metadata`, `render` |
| 1 | `codegen-ts`, `runtime-ts`, `migrate-ts`, `sdk`, `runtime-web`, `docs-site` |
| 2 | `codegen-ts-react`, `codegen-ts-tanstack`, `react` |
| 3 | `tanstack` |
| 4 | `cli`, `ai-runtime` (leaves — nothing depends on them; publish last) |

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

## Versioning policy (pre-1.0)

**The version number's only mechanical meaning today is npm's caret rule.** For
`0.y.z`, `^0.19.3` resolves `>=0.19.3 <0.20.0`, so: **PATCH is auto-adopted by every
consumer on a routine `npm update`; MINOR requires a deliberate bump of their range.**
That — not semver §8 — is the contract you are versioning against pre-1.0.

**Litmus test.** Can a consumer on `^prev` run `npm update && meta gen` and (1) still
typecheck their owned generators + hand-written imports, and (2) get output that is
byte-identical *or only corrects previously-wrong output*? **Yes to both → PATCH.
Otherwise → MINOR.**

Do NOT reach for MINOR merely because "generated output changed." Scaffold-and-own
(ADR-0034) does not firewall consumers from engine-output changes — the copied
generators are thin compositions; the `render*` primitives + defaults live in the
package and re-propagate on the next `meta gen`. So the axis is **API/default vs.
bytes**, not "did output change."

| Change class | Example | Pre-1.0 | Post-1.0 |
|---|---|---|---|
| Public API **additive** (new export / optional param / CLI flag) | new `render*` primitive | PATCH (MINOR if it headlines a feature release) | MINOR |
| Public API **breaking** (required param, removed/renamed export, changed CLI semantics) | `relativeModuleSpecifier` +required param | **MINOR** | MAJOR |
| Output change = **pure bugfix** (wrong output corrected; correct output byte-identical) | 0.19.3 payload naming, 0.19.4 TPH stamping | **PATCH** | PATCH |
| Output change alters **shape/default of *correct* output** (renamed generated export, changed default, dropped artifact) | `extStyle` `"none"→"js"` default flip | **MINOR** + a "Generated-output change" changelog flag + an opt-out where feasible | MAJOR if consumer code referencing the output breaks; else MINOR |
| New **opt-in** codegen feature, default output byte-identical | new generator defaulting off | PATCH (MINOR if it adds registry vocabulary — cross-port conformance surface) | MINOR |
| Wire-contract / conformance behavior change of already-valid deployments | FR-036 enforcement | **MINOR**, loud notice (pre-1.0 MINOR *is* the breaking slot) | MAJOR |
| Wire behavior fixed to match the documented/conformance contract | 0.19.1 `@min` clamp | PATCH | PATCH |
| No changed product file in a port | PyPI/NuGet/Maven at 0.20.14 | **Version-parity bump at the shared patch number** — publish identical content at the new version; never skip a registry (single-shared-patch policy, standing since 0.20.13) | same |

**The `extStyle` 0.20.0 case, for calibration:** it was correctly MINOR — but for the
*API break* (`relativeModuleSpecifier` gained a required param — a public export) **and**
the *default flip* (churns every existing project's diff on regen), NOT because "output
changed." Had it kept `"none"` as the default and only scaffolded `"js"` for new
projects, PATCH would have been defensible.

**Changelog convention (required for output-changing releases).** Every entry in
classes (bugfix-output) and (shape/default-output) must carry the phrase
**"Generated-output change — regenerate to pick it up; three-way merge preserves hand
edits."** The real risk of the (correct) PATCH cadence is a consumer seeing an
unexplained `meta gen` diff after `npm update`; the changelog flag + the planned
gen-state engine-version stamp (see the tracking issue) are how you keep every such
diff explained.

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

Run everything from the repo root unless noted. Bump the publish-candidate set only
(not the private root, not forge/conformance) — enumerate it (see "What gets published").

### 0. Build fresh — the stale-`dist` trap
`bun publish` does NOT rebuild, `dist/` is gitignored, and `main` points at `dist/`,
so a stale `dist` publishes code *without* your change. `tsc` also leaves orphaned
`.js` for deleted sources. **Clean-rebuild before publishing:**
```bash
bun run clean && bun run build
```
Spot-check `dist` reflects the change (a deleted source's `.js` is gone, new code present).

### 1. Release candidate → `next`
```bash
# bump the candidate set to <version>-rc.N (sed the "version" field in each publish-candidate package.json)
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

**Before `bun publish`: confirm the `local-ci` run for the release commit is green.**
Its `ts-slow` lane now carries the real-Postgres migrate gate. Publishing is irreversible on
all four registries, and the `v*` tag is pushed *after* `bun publish` — so the tag-triggered
`integration-tests` run can never be the pre-publish gate. This is the last gate that can
precede the irreversible step.

```bash
gh run list --workflow local-ci.yml --limit 1 --json headSha,conclusion
```

```bash
# bump the candidate set to the final <version>
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

Four packages, version-locked at the C# port version (currently `0.21.3`):

| Package | Contents |
|---|---|
| `MetaObjects` | Loader + canonical serializer |
| `MetaObjects.Render` | Mustache render + payload-VO + `verify` |
| `MetaObjects.Codegen` | EF Core + ASP.NET codegen + the runtime filter/dispatch helpers generated code references |
| `MetaObjects.Cli` | The `dotnet meta` .NET tool (`gen` / `verify`; `agent-docs` is a redirect stub to the Node `meta` CLI) |

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
4. **The temp key is single-use and ~1 h.** The workflow requests it immediately before push — don't
   move the `NuGet/login` step earlier.
5. **The policy is bound to the org + repo + workflow *filename*.** Renaming `publish-csharp.yml`, or
   the policy owner leaving/locking the `metaobjects` org, makes the policy inactive until fixed.
6. **Source Link + symbols are on** (`PublishRepositoryUrl`, `EmbedUntrackedSources`, `snupkg`); CI
   sets `ContinuousIntegrationBuild` for deterministic builds. No action needed — just don't strip them.

## Procedure

1. **Pick the publish commit on `main`** (a stable, merged tip — not a mid-refactor branch). Ensure
   the packaging config + `publish-csharp.yml` are on it. Set `<Version>` in `Directory.Build.props`.
2. **Validate locally** (catches immutable-version mistakes before they're permanent):
   ```bash
   cd server/csharp
   # NOTE: pack ONE project per invocation. Passing all four to a single `dotnet pack`
   # fails on modern SDKs (verified on 8.0.129) with `MSBUILD : error MSB1008: Only one
   # project can be specified` — MSBuild treats the extra paths as switches.
   for p in MetaObjects/MetaObjects.csproj MetaObjects.Render/MetaObjects.Render.csproj \
            MetaObjects.Codegen/MetaObjects.Codegen.csproj MetaObjects.Cli/MetaObjects.Cli.csproj; do
     dotnet pack "$p" -c Release -o /tmp/mo-nupkg || echo "PACK FAILED: $p"
   done
   # inspect a nuspec — version, license, readme, deps:
   unzip -p /tmp/mo-nupkg/MetaObjects.Render.0.11.1.nupkg MetaObjects.Render.nuspec | grep -iE '<id>|<version>|<license|<readme>|<dependenc'
   # optional: install the tool from the local dir and smoke-test it
   dotnet tool install --global --add-source /tmp/mo-nupkg MetaObjects.Cli && dotnet meta --help
   ```
3. **Run persistence conformance** if the runtime/codegen changed: `scripts/integration-test.sh csharp`.
4. **Publish:** GitHub → **Actions → publish-csharp → Run workflow** (or push a `csharp-v<version>` tag).
5. **Verify** on nuget.org: all four packages listed and **owned by the `metaobjects` org**
   (indexing/validation takes a few minutes).

# Releasing the Python package to PyPI

How to publish the **`metaobjects`** Python package to PyPI via **Trusted Publishing**
(OIDC from GitHub Actions) — no API token.

## What gets published

One package, `metaobjects` (version in [`server/python/pyproject.toml`](../server/python/pyproject.toml),
currently `0.21.3`), as an **sdist + a universal `py3-none-any` wheel** (pure Python).

## How we publish: Trusted Publishing (OIDC)

The workflow [`.github/workflows/publish-python.yml`](../.github/workflows/publish-python.yml)
builds with `uv` and publishes via `pypa/gh-action-pypi-publish` using OIDC.
Trigger it manually (**Actions → publish-python → Run workflow**) or with a `python-v*` tag.

### One-time setup on PyPI

Project `metaobjects` → **Settings → Publishing → Add a new GitHub publisher**:

| Field | Value |
|---|---|
| Owner | `metaobjectsdev` |
| Repository | `metaobjects` |
| Workflow | `publish-python.yml` |
| Environment | *(leave empty)* |

(The initial `0.9.0` was published from a local `uv publish`; this workflow makes
subsequent releases keyless.)

## Gotchas (the non-obvious ones)

1. **PyPI versions are immutable** (like npm/NuGet). You can't re-upload a version — only
   yank. Validate locally first (below).
2. **Bump the version in `pyproject.toml`** (`[project].version`).
3. **The wheel is pure-Python/universal** (`py3-none-any`) — one wheel serves every platform.

   (No agent-context content is vendored into the wheel anymore — scaffolding moved to the
   Node `meta agent-docs` CLI, so `hatch_build.py` is a no-op. Don't re-add a
   `force-include` of `../../agent-context`.)

## Procedure

1. **Bump** `[project].version` in `server/python/pyproject.toml`.
2. **Validate locally** (versions are immutable):
   ```bash
   cd server/python
   rm -rf dist && uv build --out-dir dist        # must produce BOTH .tar.gz and .whl
   uvx twine check dist/*                         # metadata + README render
   ```
3. **Publish — MANUAL (`uv publish`), not the OIDC workflow.** Trusted Publishing is
   misconfigured ([#36] — `publish-python.yml` fails with `invalid-publisher`), so publish
   from the local build with the token in `~/Work/Keys/pypi.txt`:
   ```bash
   cd server/python   # after the `uv build` above produced dist/
   # the token is line 4 of the key file, AFTER the "secret: " label — strip it or you get a 403:
   UV_PUBLISH_TOKEN="$(sed -n '4p' ~/Work/Keys/pypi.txt | sed 's/^secret:[[:space:]]*//')" uv publish dist/*
   ```
   (When #36 is fixed, switch to **Actions → publish-python → Run workflow** / a `python-v<version>` tag.)
4. **Verify:** `curl -s https://pypi.org/pypi/metaobjects/json | python3 -c "import sys,json;print(json.load(sys.stdin)['info']['version'])"`.

# Releasing the Java/Kotlin modules to Maven Central

The 18 `com.metaobjects:*` modules ship to **Maven Central via the Sonatype Central Portal**,
versioned on the `7.x` line (currently `7.21.3`) in the parent + module poms. Signed with the
maintainer's GPG key.

## Procedure

1. **Bump** the version in **all** poms — parent + reactor modules **and the two
   reactor-EXCLUDED integration-test modules** (`server/java/integration-tests/pom.xml`,
   `server/java/integration-tests-kotlin/pom.xml`). Use the tree-wide `grep`, NOT
   `mvn versions:set`: `versions:set` only walks the reactor and silently leaves the
   excluded modules behind, so their `<parent><version>` lags and the next tag fails
   `release-gate (java|kotlin)` with "Non-resolvable parent POM".
   ```bash
   grep -rl 7.7.8 --include=pom.xml server/java | xargs sed -i 's/7\.7\.8/7.7.9/g'
   ```
   (Verify every `<version>7.4.0</version>` is the project version, not a third-party dep.)
   Then assert the excluded modules are in sync: `scripts/check-pom-versions.sh`
   (also enforced on every push by `.githooks/pre-push` and by `scripts/ci-local.sh`).
2. **Validate locally:** `cd server/java && mvn -q clean install -DskipTests` (or with tests / `scripts/integration-test.sh java` if runtime changed).
3. **Deploy:** `mvn -Prelease deploy` from `server/java`. The `central-publishing-maven-plugin`
   (`<publishingServerId>central</publishingServerId>`, `<autoPublish>true</autoPublish>`) uploads
   the signed bundle and auto-releases — **no manual staging → release promotion**. Auth + the GPG
   passphrase come from `~/.m2/settings.xml` (server ids `central` + `gpg-credentials`); the GPG
   secret key must be present (`gpg --list-secret-keys`). The release profile activates GPG signing
   + the javadoc/sources jars Central requires.
4. **Verify:** the modules appear at `https://central.sonatype.com/` / `https://repo1.maven.org/maven2/com/metaobjects/` (indexing takes minutes).

> Gotchas: Maven Central versions are immutable (like the others); `groupId` ownership is already
> verified for `com.metaobjects`; a missing GPG key or expired Central token fails the deploy with
> an auth error, not a clear message.
>
> **`central-publishing-maven-plugin 0.6.0` crashes COSMETICALLY** (`UnrecognizedPropertyException:
> "warnings"` while parsing Sonatype's response) — `mvn` exits non-zero, but the bundle DID publish
> (all modules go live on Central via autoPublish). Do **not** blindly re-run (versions are
> immutable) — first VERIFY:
> ```bash
> for m in metadata om omdb-ktx render codegen-spring spring-boot-starter; do
>   curl -s -o /dev/null -w "%{http_code} metaobjects-$m\n" \
>     "https://repo1.maven.org/maven2/com/metaobjects/metaobjects-$m/<version>/metaobjects-$m-<version>.pom"; done
> ```
> If all are `200`, the release is out — the error was just the response parse. Bump the plugin to
> ≥`0.7.0` to stop the crash on the next release.

**The `minor.patch` IS unified across languages** (standing policy since 0.20.13): npm, PyPI and
NuGet share `0.<m>.<p>`, and Maven Central ships the same `minor.patch` on its historical major `7`.
Every release bumps all four registries, with version-parity bumps where a port has no changed
file. The cross-language *behavior* contract
is the **conformance corpus + [`fixtures/conformance/CAPABILITIES.json`](../fixtures/conformance/CAPABILITIES.json)**:
each release states which capabilities/conformance level it satisfies, and *that* manifest — not a
shared version — is the coordination point. (Generated code runs without any MetaObjects runtime, so
a language only publishes the libraries it actually ships: runtime helpers, and codegen where it exists.)

## Public-repo hygiene

This repo is public. Before committing release changes, ensure no local paths or private/consumer
names leak (the `.githooks/pre-commit` guard enforces this — activate with
`git config core.hooksPath .githooks`). See [CLAUDE.md](../CLAUDE.md) → *Public repository hygiene*.
