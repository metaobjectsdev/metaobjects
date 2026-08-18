# Pre-releases: iterating an unreleased version against downstream consumers

Testing an unreleased change against a real downstream project used to require cutting a
real release on npm / PyPI / NuGet / Maven Central. All four registries are **immutable**:
the version number is spent the moment it ships, `latest` moves, and every consumer on a
caret range can pick it up. That is an expensive way to answer "does this change work in a
real app?" — and it is the reason `0.21.2` had to be cut within an hour of `0.21.1`.

This page describes the alternative. Publish a **pre-release** to a **separate registry**,
consume it from a downstream project, iterate, and switch that project back to public
releases with a verified one-command revert.

| | |
|---|---|
| Registry | one Gitea instance serving npm, PyPI, NuGet and Maven — the address is configuration (`MO_REGISTRY_BASE`), never a committed default; see [§7](#7-running-your-own-registry) |
| Reads | **anonymous** — a consumer needs the URL and the owner, no account and no token |
| Writes | token only, in gitignored local config, never in a committed file |
| Publisher | `bun run prerelease` (`scripts/prerelease.mjs`) |
| Consumer | `tools/prerelease/prerelease-link.sh link` / `unlink` |
| Guard (consumer) | `tools/prerelease/detect-prerelease-pins.sh` |
| Guard (this repo) | `scripts/check-no-prerelease-versions.sh` |

---

## 1. The version scheme

One canonical internal string, normalized per ecosystem in exactly one place
(`const V` in `scripts/prerelease.mjs`):

| | canonical | npm | PyPI | NuGet | Maven |
|---|---|---|---|---|---|
| form | `<base>-rc.<N>` | `0.24.0-rc.3` | `0.24.0rc3` | `0.24.0-rc.3` | `7.24.0-rc.3` |
| why | | SemVer2 verbatim | PEP 440 canonical form | SemVer2 verbatim | same `minor.patch` on the historical major `7` |

`<base>` is the in-development version — the next minor by default — and `<N>` is a
**monotonic iteration counter**, derived from what the registry already holds across all
four ecosystems so that `--only npm` today and `--only csharp` tomorrow cannot collide.

**Why a counter and not a commit sha.** npm *strips* SemVer build metadata:
`0.24.0-rc.1+aaa` and `0.24.0-rc.1+bbb` compare **equal**, so the second publish is refused
as a duplicate. The sha still travels where it is useful — the C# packages carry it in
`AssemblyInformationalVersion` via Source Link — but it cannot be the thing that makes two
iterations distinct.

**Why not one mutable `-dev` version.** Deleting and re-pushing the same version is
possible, and it silently serves the consumer **stale bytes**: with a lockfile and a warm
client cache, `npm install` resolves the old tarball with no error and no warning. An
immutable per-iteration version makes "did my fix actually reach the consumer?" answerable
by reading a version number.

`-rc.N` sorts correctly everywhere, including numerically in Maven (`rc.2` before `rc.10`),
and it sorts **below** the eventual release. Neither `^0.23.2` nor `^0.24.0` matches
`0.24.0-rc.1`, so a pre-release can never be picked up by an existing range.

### A burned version number can never come back

npm versions are permanent in a stronger sense than "you should not republish": once
anything depends on a version, `npm unpublish` is **refused** (`E405`), and deprecating it
does not free the number. `@metaobjectsdev/metadata@0.24.0-rc.1` is burned exactly that
way — published to public npm by accident while this design was being validated, and now
unremovable. Nothing else in the lockstep set carries it, which is what makes it dangerous:
a lockstep RC at `0.24.0-rc.1` would publish thirteen packages successfully and then fail
irreversibly on the fourteenth.

Two places now handle that instead of discovering it late:

- `bun run prerelease` picks its iteration number by skipping every number already taken on
  the pre-release registry **or on public npm**, for any package in the set. With
  `0.24.0-rc.1` burned and `rc.1`–`rc.3` used privately, it selects `rc.4`. An explicit
  `--iter` that lands on a burned number still works — the pre-release registry is a
  separate namespace — but warns that the number can never be promoted.
- `bun run release` checks the target version against **every** package in the lockstep
  set before it publishes anything. It previously checked only `@metaobjectsdev/cli`, which
  would not have seen this at all.

> Do **not** use `-next.N`. Maven treats `next` as an *unknown* qualifier, which ranks
> **above** the plain release: `7.24.0-next.3` sorts newer than `7.24.0`.

---

## 2. Publishing

One-time, on the publishing machine:

```bash
cp tools/prerelease/registry.env.example tools/prerelease/registry.env
# fill in MO_REGISTRY_OWNER and MO_REGISTRY_TOKEN — the file is gitignored
```

Then:

```bash
bun run prerelease                      # next iteration, npm (the default scope)
bun run prerelease --only python,csharp # pick ports
bun run prerelease --only all           # all four
bun run prerelease --iter 7             # pin the iteration number
bun run prerelease --base 0.25.0        # target a different in-development version
bun run prerelease --dry-run            # build + normalize + gate, publish nothing
```

Version declarations are edited in place and **always restored on exit**; the script
refuses to start if any of them is already dirty.

### The publish-target gate

The registry is a public HTTPS endpoint. "It is only bound to loopback" is not the safety
model and never was the durable one. These are:

1. The target must equal the **configured** registry (or be loopback) — an equality test,
   not a hostname pattern.
2. An independent deny-list of the public registries (`registry.npmjs.org`, `pypi.org`,
   `api.nuget.org`, `central.sonatype.com`, …). Two checks that fail differently beat one
   check trusted twice.
3. For npm, `bun publish --dry-run` is **parsed** and its reported registry compared to the
   expected one. This is not paranoia: bun ignores `npm_config_userconfig`, and during this
   design's validation it silently fell back to the user-level `~/.npmrc` and published a
   pre-release to the **public** registry. bun is not taken at its word anywhere here.
4. `HOME` is redirected to a scratch directory holding only the pre-release `.npmrc`, so a
   fall-back has no credential to publish with even if it happens.
5. Maven deploys with an explicit `-DaltDeploymentRepository` and never `-Prelease` — this
   repo declares `distributionManagement` only inside the `release` profile, so a bare
   `mvn deploy` has no target at all. Its local repository is a scratch directory, so a
   pre-release never lands in the `~/.m2` that ordinary builds resolve from.

---

## 3. Consuming — one command in each direction

```bash
# from the consumer project root
tools/prerelease/prerelease-link.sh link --version 0.24.0-rc.3
tools/prerelease/prerelease-link.sh check
tools/prerelease/prerelease-link.sh unlink --to 0.23.2
```

`link` detects which ecosystems the project uses and configures only those, scoped to the
vendor namespaces (`@metaobjectsdev/*`, `metaobjects`, `MetaObjects*`, `com.metaobjects`).
Everything else keeps resolving from the public registry — verified: `zod` and `pyyaml`
still come from npmjs.org and pypi.org while the vendor packages come from the pre-release
registry.

Everything it writes is delimited by managed markers, so `unlink` removes exactly what
`link` added:

| ecosystem | what `link` writes | mechanism |
|---|---|---|
| npm | `.npmrc` scope line | `@metaobjectsdev:registry=…` |
| Python | `pyproject.toml` block | `[[tool.uv.index]] explicit = true` + `[tool.uv.sources]` — real per-package index pinning |
| NuGet | `NuGet.config` | a second source plus `packageSourceMapping` limiting it to `MetaObjects*` |
| Maven | `pom.xml` `<repositories>` | plus `.mvn/settings.xml` when the registry is plain `http` (see below) |

Files that are not normally tracked (`.npmrc`, `NuGet.config`, `.mvn/*`) are also added to
the project's `.git/info/exclude`, which is local and not committed. Files that *are*
tracked by definition (`pyproject.toml`, `pom.xml`) get a loud warning instead — there is
no way to make an edit to a tracked file uncommittable, which is precisely why the detector
in §5 exists.

After `link`:

```bash
npm     rm -f package-lock.json && npm install
python  uv lock && uv sync
nuget   dotnet restore --force-evaluate --no-cache
maven   mvn -U compile
```

> **NuGet's two flags are both required.** NuGet caches the service index, so a plain
> `dotnet restore` — and even `--force-evaluate` on its own — will happily keep resolving
> the previous iteration of a floating version.

> **Maven blocks plain-http repositories** since 3.8.1, via a built-in
> `maven-default-http-blocker` mirror, and the error names the blocker rather than the
> cause. Against an `http://` registry `link` writes `.mvn/settings.xml` + `.mvn/maven.config`
> using `-gs`, which **merges** with your own `~/.m2/settings.xml` rather than replacing it.
> `unlink` deletes both — leaving them behind would keep a security default suspended for
> that project forever. The project registry is HTTPS, so this path does not trigger for it.

### Outside collaborators

Reads are anonymous, so someone outside the project needs no account and no token. Give
them the two scripts (or a checkout of this repo) and one variable:

```bash
MO_REGISTRY_OWNER=<owner> tools/prerelease/prerelease-link.sh link --version 0.24.0-rc.3
npm install
```

and to get back off it:

```bash
tools/prerelease/prerelease-link.sh unlink        # --to defaults to the current npm `latest`
npm install
```

They need to be told `MO_REGISTRY_BASE` and `MO_REGISTRY_OWNER` — neither is defaulted
(§7) — and no token, because reads are anonymous. `unlink` needs nothing at all.

---

## 4. Why the config is per-project and never machine-global

A user-level `~/.npmrc`, `~/.m2/settings.xml`, `~/.config/NuGet/NuGet.Config` or `~/.pypirc`
would be less typing. It is the wrong answer, for three reasons:

1. **It is invisible to the detector.** The detector reads the *project*. A machine-wide
   redirect leaves nothing in the repository to find, so "is this branch safe to merge?"
   stops being answerable by any check — which is the exact failure this design exists to
   make impossible.
2. **It switches every project at once.** You cannot then have one consumer on a
   pre-release and the rest on public releases, which is usually the comparison you want.
3. **A silent fall-back to user-level config is how a pre-release reached a public
   registry** during this design's own validation. A tool ignored the config it was handed,
   found the user-level file instead, and published for real. Machine-global config is not
   a convenience here; it is the loaded gun.

---

## 5. The guards, and why they are load-bearing

The registry is a public HTTPS endpoint reachable from anywhere. There is no network
boundary doing safety work: **these checks are the containment**, not a second opinion on
top of it. Treat a failure as a build break.

### In a consumer: `tools/prerelease/detect-prerelease-pins.sh`

`link` installs it into the consumer at `tools/prerelease/detect-prerelease-pins.sh`.
**Commit it and run it in CI** (and from a pre-commit hook). It flags:

1. the pre-release registry's host — read from `MO_REGISTRY_BASE`, never a committed
   default (§7), since this file ships into adopter repositories. Unset, this one check
   **announces that it did not run** rather than passing in silence, because a guard that
   is quiet when it skips cannot be told apart from a guard that looked and found nothing.
   `link` passes the address through, so the linked consumer gets it; the other four
   checks are host-independent and always run — check 3 in particular catches a
   pre-release pin no matter where it came from;
2. any private-network or loopback registry host (someone else's self-hosted instance);
3. a vendor dependency pinned to a pre-release version, in any of the four spellings — the
   only signal that survives `pip freeze`, which records no index provenance at all. In
   manifests the name and the version share a line, so the match is namespace-anchored
   exactly; in **lockfiles** they sit on different lines, so there — and only there — a
   proximity window is used instead. Keeping the window out of manifests is deliberate: it
   would flag a third-party `rc`/`beta` that merely happens to sit near a vendor entry;
4. an npm dependency declared as a bare dist-tag, which floats;
5. a Maven pom pinning a pre-release in a `<dependency>` or `<properties>` block — the
   project's own `1.0.0-SNAPSHOT` version is normal and is deliberately not flagged.

It scans **dependency declarations only** — manifests and lockfiles. A source file that
binds a test server to `127.0.0.1`, or a design doc quoting an old `-SNAPSHOT`, is not a
dependency on anything, and a check that cries wolf is a check people learn to ignore.

### In this repo: `scripts/check-no-prerelease-versions.sh`

Runs in the `gates` lane of `scripts/ci-local.sh` and from `.githooks/pre-commit` whenever a
version-bearing file is staged. A committed pre-release version is not cosmetic:
`scripts/release.mjs` derives the whole lockstep set from the CLI's *current* version, so a
stray `-rc.N` in one `package.json` would silently drop that package from the next real
release.

### What is deliberately NOT in CI

There is no pre-release publish workflow in GitHub Actions, and there should not be one.
Publishing needs the write token, and a hosted job holding a token whose only purpose is to
push unreleased artifacts is a standing risk with no matching benefit — the loop it serves
is a developer iterating against a project on their own machine. Pre-release publishing
stays local; the *guards* are what belong in CI.

---

## 6. Relationship to a real release

`bun run release` (`scripts/release.mjs`) is unchanged and still publishes to the public
registries. `docs/RELEASING.md` keeps its public-npm RC path for the one case a private
registry cannot cover: a release where dependencies or package layout changed, where the
thing being tested *is* a real external install from the real registry.

Everything else — "does this change work in a downstream app?" — belongs here.

---

## 7. Pointing the tooling at a registry

**There is no default.** `MO_REGISTRY_BASE`, `MO_REGISTRY_OWNER` and `MO_REGISTRY_TOKEN`
all come from the environment or from `tools/prerelease/registry.env` (gitignored; copy
`registry.env.example`), and the tooling refuses rather than guessing. The token is a
credential and the owner is an account name, which is the obvious reason for two of them —
the address is in the same set because it is *infrastructure belonging to whoever runs the
registry*, and this repository is public: a committed hostname propagates one operator's
infrastructure to every reader, every fork, and — via
`tools/prerelease/detect-prerelease-pins.sh`, which installs into consumer repos — every
adopter. Without it, that guard's registry-address check announces that it did not run
rather than passing silently.

Any Gitea instance works. To stand one up (a fork, another team, an offline machine):

```bash
docker compose -f tools/prerelease/docker-compose.yml up -d
tools/prerelease/bootstrap.sh          # creates the owner + token, writes registry.env
```

The publisher and the link helper are registry-agnostic; nothing else changes.

> A CDN in front of the registry may cap request bodies (100 MB on Cloudflare's free plan),
> in which case a very large artifact fails at the edge rather than at Gitea. Every artifact
> this repo publishes is far below that.
