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
> Run network commands via the sandbox-disabled shell. **Publish what changed; converge the
> number when you do (standing policy since 0.24.5, replacing the version-parity rule of
> 0.20.13):** a registry publishes only when it has a changed product file, and when it does it
> adopts the **current shared `minor.patch`** — skipping the numbers it sat out. npm / PyPI /
> NuGet on `0.<m>.<p>`, Maven on `7.<m>.<p>` (only the major differs, for historical continuity).
> Two carve-outs: the **14 npm packages still move atomically with each other** (they
> cross-depend — that is intra-npm lockstep and it is unchanged), and a change to
> `expected-registry.json` / `metamodelVersion` **forces all four**, because that is the
> cross-port contract. The rest of this doc is the per-registry procedure.

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
previous version":

```bash
node scripts/publish-set.mjs --check    # the set + its tier order, and the invariants
```

> `scripts/publish-set.mjs` is the single source of truth for the set and its order.
> Both publish paths read it — `scripts/release.mjs` and
> `.github/workflows/publish-npm.yml` — because they used to answer the question
> separately and drifted: the workflow's hardcoded list of 13 directories omitted
> `@metaobjectsdev/docs-site`, which `@metaobjectsdev/cli` depends on at runtime, so a
> release cut through the workflow would have published a `cli` pinning a `docs-site`
> version nobody published (`npm i @metaobjectsdev/cli` → `ETARGET`). It also asserts
> what the tier table below asserts in prose: every member has a declared tier, nothing
> publishes before its own dependencies, and the set is closed over its sibling deps.
> Runs in the `gates` lane; the table stays as the human-readable statement of intent.

> **Mind the gap in that rule.** A non-`private` package on its OWN version line is
> at neither the previous lockstep version nor `private`, so it matches neither
> branch and gets silently skipped by every release. That is exactly what happened
> to `@metaobjectsdev/angular` + `@metaobjectsdev/codegen-ts-angular` (their own
> `0.6.x` line): **never published**, while the README, `CLAUDE.md`, four port docs
> and a full recipe described them as installable. `scripts/check-publish-intent.sh`
> now fails the build on any non-private package that is neither at the lockstep
> version nor declared source-only, so the decision has to be made out loud. It runs
> in the `gates` lane; run it yourself before a cut.
>
> For the Angular pair the decision **has been made**: they stay source-only on
> purpose ([ADR-0048](../spec/decisions/ADR-0048-angular-tier-source-only.md)).
> A release cut must NOT sweep them into lockstep or publish them under any
> dist-tag; they join the tier table only when the ADR's promotion bar is met.

| Tier | Packages |
|---|---|
| 0 | `metadata`, `render` |
| 1 | `codegen-ts`, `runtime-ts`, `migrate-ts`, `sdk`, `docs-site`, `runtime-web` |
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

5. **npm versions are immutable, and a burned one never comes back.** You can never
   re-publish a version. Unpublish is not a reliable escape hatch: it is *refused* (`E405`)
   once anything depends on the version, and deprecating it does not free the number.
   `@metaobjectsdev/metadata@0.24.0-rc.1` is burned that way and no other package in the set
   carries it — so a lockstep RC at `0.24.0-rc.1` would publish thirteen packages and then
   fail irreversibly on the fourteenth. `scripts/release.mjs` now preflights the target
   version against **every** package in the set (it used to check only the cli), and
   `bun run prerelease:publish` skips burned numbers when choosing an iteration.

6. **Any commit that bumps a version must regenerate the site payload: `bun run site:payload`.**
   `examples/showcase/site-payload.json` embeds all five coordinates — npm, PyPI, NuGet, Maven
   and `metamodelVersion` — so a bump changes it, and `gate_site_payload` in the `gates` lane
   compares the committed bytes against a fresh build on every push to `main`. A coordinated cut
   lands as **two** commits and both touch coordinates: `scripts/release.mjs` regenerates and
   stages the payload for the TypeScript one automatically, but the
   `chore(release): … PyPI, NuGet and Maven Central` commit is written by hand and must do it
   too. Forget it and `main` goes red on the next push; once the site injection lands, the page
   would publish the previous release's versions.

7. **`v<version>` is cut LAST, and it is not just a marker — the website deploys from it.**
   metaobjects.dev's Pages workflow resolves the newest `v0.x` tag, clones that tree, and
   injects its `examples/showcase/site-payload.json` into the pages. So the tag decides
   what the site states about the release, **including all five version coordinates.**

   A coordinated cut is **two commits** — npm's, then the hand-written PyPI/NuGet/Maven
   bump. `release.mjs` used to tag between them, which names a tree whose payload reads
   `{npm: <new>, pypi: <old>, nuget: <old>, maven: <old>}`: three versions that were never
   released. `v0.24.5` carries exactly that, and nothing caught it because no page
   displayed a coordinate yet.

   So `release.mjs` pushes `main` and **stops**. After the ports are bumped, committed,
   pushed and tagged (`python-v*`, `csharp-v*`, `java-v7.*`), run:

   ```bash
   bun scripts/finish-release.mjs <version>            # gates, then tags and pushes
   bun scripts/finish-release.mjs <version> --check    # gates only
   ```

   It refuses to tag a tree that does not state the release: a dirty or unpushed tree, a
   **failed `git fetch`** (which makes the sync claim unverifiable, so it is a refusal
   rather than a tick), a tag that already exists (never move one — a moved tag silently
   changes what the site deploys), payload coordinates that disagree with what shipped, a
   missing injector / payload / `site-reference/`, **llms mirrors naming a version this
   release did not ship on any line that makes a registry claim**, or a tag the deploy's
   own filter would not resolve.

   A registry that genuinely **sat out** the release under publish-what-changed is declared
   (`--sat-out pypi,nuget`) rather than guessed — guessing "sat out" ships the stale number,
   and guessing "published" blocks a correct lagging registry. **npm can never sit out:**
   `<version>` *is* the npm version, so a mismatch there always means
   `bun run site:payload` was not re-run.

   **`--sat-out` is corroborated, not believed.** A registry that truly sat out has an
   UNMOVED manifest (`pyproject.toml`, `Directory.Build.props`, the reactor pom); a payload
   that was simply not rebuilt sits beside a manifest that DID move, and declaring that one
   `--sat-out` is refused with the manifest quoted back. This matters because an earlier
   version printed the flag as a ready-made remedy for any mismatch — which would have
   waived the exact defect the gate exists to catch.

   **Every refusal above is pinned by `scripts/finish-release.test.ts`**, which runs in the
   `gates` lane and exercises the real script against throwaway origin+clone pairs. Before
   it, this file ran in no lane and had no tests while deciding what the website publishes;
   a review found eight defects in 172 lines. If you change a gate, change its case there —
   and check the change against a mutation, not just a green run.

   **A second effect, and it is an improvement rather than a cost.** `conformance.yml` and
   `integration-tests.yml` are the heavy gates that run on a `v*` tag and nowhere else.
   Cutting the tag last means they now run against the FINAL coordinated tree — all four
   registries bumped, docs refreshed, payload true — instead of the npm-only commit, which
   is a tree that never actually shipped. `publish-npm.yml` triggers on `npm-v*`, not `v*`,
   so moving the tag does not re-trigger a publish.

## Versioning policy

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
| New **opt-in** codegen feature, default output byte-identical | new generator defaulting off | PATCH | MINOR |
| New **attribute** on an existing type/subtype | `@intValueMap`, `@lenient`, `@maxTokens` | **PATCH** | MINOR |
| New **subtype** of an existing type | `field.uri`, `index.lookup`, `attr.intMap` | **PATCH** when inert (see the vocabulary rule below); **MINOR** when it changes existing metadata's meaning/output, narrows something previously permitted, or headlines a feature | MINOR |
| New top-level metadata **type** | `requirement.*`, `index.*`, `api.*` | **MINOR** | MINOR |
| **Breaking** metamodel-vocabulary change (retire an attr/subtype/type; narrow what is permitted) | FR-037 `@readOnly`, FR-038 `@verifiedBy`, ADR-0052 `@promptStyle` re-homing | **MINOR** (pre-1.0 MINOR *is* the breaking slot) | **`metamodelVersion` MAJOR**, package MINOR (ADR-0035 Am. 2) |
| Wire-contract / conformance behavior change of already-valid deployments | FR-036 enforcement | **MINOR**, loud notice (pre-1.0 MINOR *is* the breaking slot) | **`metamodelVersion` MAJOR** (Metamodel 2.0) + package MINOR — see the two-contracts rule below |
| Wire behavior fixed to match the documented/conformance contract | 0.19.1 `@min` clamp | PATCH | PATCH |
| No changed product file in a port | PyPI/NuGet/Maven at 0.24.4 while npm cuts 0.24.5 | **Do not publish that registry.** It sits the release out and keeps its current version. When it next has a changed file it adopts the shared `minor.patch` then current, skipping the numbers between (publish-what-changed policy, standing since 0.24.5) | same |
| A change to `expected-registry.json` / `metamodelVersion` | any vocabulary move | **All four registries publish**, changed file or not — the metamodel is the cross-port contract and every port byte-matches the manifest | same |

### The two-contracts rule (post-1.0; ADR-0035 Amendment 2)

**Package 1.0 does not freeze the metamodel.** After the cut, the project versions two
contracts on two numbers:

- **Package version** (npm/PyPI/NuGet `1.x`, Maven `8.x`) promises the SOFTWARE surface —
  exports, CLI flags, generated-code shape, runtime helpers. A break here is `2.0.0` /
  `9.0.0`.
- **`metamodelVersion`** (`"1.0"` at the cut; the current value is the first key of the
  byte-gated `expected-registry.json`) promises the METADATA contract — registered
  vocabulary, canonical/interchange format, wire contract. A break here moves ITS major,
  and **does not force a package major.**

That severance is the whole point: under the pre-amendment rule one vocabulary retirement
dragged npm to `2.0.0` and Maven to `9.0.0`, so the package majors became a running count
of metamodel edits. Measured cadence at the time of the amendment: **19 minor lines in 87
days**.

**The gate: `node scripts/check-metamodel-version.mjs`** (runs in the `gates` lane, so
`scripts/ci-local.sh` and hosted CI both enforce it). It diffs
`expected-registry.json` — already the byte-exact bill of materials every port is gated
against — against its content at the **last release tag**, classifies every difference,
and fails if the declared version did not move by at least the amount the change
requires. Same shape as `buf breaking --against '.git#tag=…'` / `oasdiff`.

| Change | Required move |
|---|---|
| a type/subtype removed; an attr removed; an attr made required, retyped or re-arrayed; an enum member removed or an open attr closed; a child rule removed, its `min` raised or its `max` lowered; a default subtype changed | **major** (pre-1.0: minor — see below) |
| a type/subtype added; an optional attr added; an enum member added; a child rule added or relaxed; a default subtype added | **minor** |
| prose only (`description` / `rules` / `whenToUse`) | none — but read the warning |

**Pre-1.0 a breaking change moves the MINOR**, for the same reason the package line
works that way while it is `0.x`: `0.y` makes no compatibility claim there is anything to
break. At `1.0` the major becomes real.

**What the gate cannot see, and says so.** A rule can change with NO machine-readable
footprint. #210 is the proof: retiring assembly origins from `object.value` was a
breaking metamodel change whose only manifest edit was a `rules` PROSE string. So prose
changes are reported as a WARNING with a direct question — *did the rule change, or only
its wording?* — rather than classified, because a typo fix and a semantics change are
indistinguishable here and failing on every wording edit trains people to ignore the
gate. **Answering that question is a human step in every release.**

**When you cut a release that moves `metamodelVersion`:**

1. `node scripts/check-metamodel-version.mjs --set <version>` — it writes the manifest
   **and all four port constants** in one go (Kotlin emits through the JVM's). A partial
   edit is caught by `registry-conformance`, but only in the lane for the port you
   forgot, so do not hand-edit. Then re-run the corpus in every port.
2. The changelog entry MUST say the metamodel version moved, and to what. Post-1.0 the
   caret rule is no longer a gate (`^1.0.0` accepts `1.1.0`), so **the changelog is the
   adopter's only signal** until the deferred loader check exists.
3. Ship a migration guide under `docs/features/migrations/`, as every breaking metamodel
   change already does.

`--explain` prints the full classified diff and always exits 0; `--against <ref>` picks a
different baseline.

Design + deferral triggers:
[`docs/superpowers/specs/2026-08-20-two-contracts-versioning-design.md`](superpowers/specs/2026-08-20-two-contracts-versioning-design.md).

**Cadence is a separate lever, and it is free.** Nothing forces one release per merged
change; batching a fortnight of work into one coordinated cut removes most of the number
pressure without touching policy at all.

### The vocabulary rule (corrected 2026-08-17)

**Adding registry vocabulary does NOT, by itself, force a MINOR.** The rule used to read
"PATCH (MINOR if it adds registry vocabulary — cross-port conformance surface)", and that was
wrong on its own terms: `expected-registry.json` is an **internal** gate. Every port
byte-matching one manifest is how we stop the five ports drifting from each other — it says
nothing about whether an *adopter's* project changes. Treating an internal gate's churn as an
adopter-facing event is what burned the minors: `0.22.0` and `0.23.0` were both cut MINOR for
changes that a project declaring no `requirement.*` nodes could not observe at all, which each
changelog says out loud in its own opening paragraph. Sort vocabulary by what it can do to a
consumer, which splits three ways:

- **A new ATTRIBUTE is a PATCH.** You get it only by authoring it. Every existing document
  loads unchanged and emits byte-identical output, so there is nothing for a consumer to adopt
  deliberately.
- **A new TOP-LEVEL TYPE is a MINOR.** A type is a new modeling concept with its own children,
  validation and (usually) tooling surface — `requirement.*` brought its own `verify` pass and
  summary output. That is a thing a consumer newly depends on, and it deserves a deliberate
  range bump.
- **A new SUBTYPE goes either way, and the test is whether it is INERT.** PATCH when nothing
  but authoring it can reach it: no existing valid document changes meaning or output, nothing
  previously permitted is narrowed, nothing reserved is consumed. MINOR when any of those
  fails — a subtype that closes a wildcard, promotes a reserved-not-registered member
  (ADR-0007 Amendment 2 / ADR-0040), or shifts what the recommended shape for an existing
  field *is* — or when you deliberately want it behind a range bump because it headlines a
  release. Most subtypes carry a native type and behavior (that is ADR-0037's very test for
  making something a subtype), so read them carefully; but "it appears in the registry
  manifest" is not the deciding fact.

**Do not invert the caret rule.** "Pre-1.0 `^0.22.x` resolves `<0.23.0`, so a consumer adopts
a MINOR deliberately" is a reason to *choose* MINOR when you want that gate. It is not a
reason additive vocabulary *must* be MINOR. The gate exists to be used on purpose, not by
reflex — and a minor spent on a change nobody can observe is a gate you no longer have when
something real needs it.

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
  read+write to `@metaobjectsdev`, in `~/.npmrc` (`//registry.npmjs.org/:_authToken=...`).

  > **The token TYPE is the whole game, and a wrong one looks right.** A classic **"Publish"**
  > token authenticates fine — `npm whoami` returns your username, `npm access list packages`
  > shows `read-write`, and `bun publish --dry-run` passes — and then returns **`EOTP`** on
  > every actual write. Worse, `bun publish` defaults to `--auth-type=web`, so it falls back to
  > an interactive **browser** flow (`https://www.npmjs.com/auth/cli/…`) that cannot complete
  > in CI or any non-interactive shell; `--otp=` is silently IGNORED (bun prompts `Enter OTP:`
  > regardless, so a code must be piped on **stdin**). And if the account's 2FA is a security
  > key rather than TOTP, there is no 6-digit code to supply at all. Use **Classic → Automation**
  > (or a granular token with 2FA-bypass enabled).
  >
  > **Do NOT try to prove the token type with a write against a published package.** The
  > obvious probe — `npm dist-tag add … auth-probe` then `rm` — is **not reversible**: since
  > 2026-07-31 a bypass-2FA token may still *publish* but may not change package access,
  > so the `add` succeeds and the `rm` returns `403` ("Granular access tokens that bypass
  > two-factor authentication may not perform this action"). That strands a stray tag on a
  > public package needing an interactive-2FA session to clear. It was tried on the 0.24.0
  > cut; don't repeat it.
  >
  > Verify what can be verified read-only, and let the publish itself be the rest:
  > ```bash
  > node scripts/release-verify.mjs --preflight       # auth + scope, no writes
  > ```
  > `whoami` and `access list` are both READS, so neither proves write capability — the
  > preflight says so rather than implying otherwise. **The tier-0 publish is the real
  > probe**: `metadata` publishes first, so a wrong token fails there, before anything
  > depends on it. `scripts/release.mjs` also runs `npm whoami` in phase 0, so a dead
  > credential is caught BEFORE the version bump is committed rather than after other
  > registries have shipped irreversibly.

  Revoking the token after each release is a deliberate trade — it is also why the credential
  is reliably dead at the start of the next cut. Whichever you choose, do it knowingly.

  > **Deadline: npm removes direct publishing from 2FA-bypass tokens around January 2027**
  > ([changelog](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)).
  > The replacement is **Trusted Publishing (OIDC)** — the same mechanism `publish-csharp.yml`
  > already uses for NuGet — via `publish-npm.yml`, which exists and needs a trusted-publisher
  > registration per package on npmjs.com. This is a dated requirement, not the "future
  > improvement (research-backed, not yet adopted)" that `.claude/skills/releasing/SKILL.md`
  > still files it under.
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

> **Most changes do not need this.** To try an unreleased change against a downstream
> project, publish a PRE-RELEASE to the private registry instead —
> [`docs/features/prerelease.md`](features/prerelease.md), `bun run prerelease:publish`. It is
> reversible, invisible to the public registries, and costs no version number.
>
> A **public** RC is for the one case a private registry cannot cover: **dependencies or
> package layout changed**, so the thing being tested IS a real external install from the
> real registry — a misclassified `dependencies`/`devDependencies` entry, a peer range, a
> new package name, an `exports` map. Rule 4 below only means something against npmjs.org.
>
> Remember what it costs: an RC version is permanent. Once anything depends on it,
> `npm unpublish` is refused outright and deprecating it does not free the number.

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
git push origin main                             # NO tag here — see golden rule 7
```

**The `v<version>` tag is cut LAST, by `scripts/finish-release.mjs`** — after PyPI, NuGet
and Maven have been bumped, committed and published. See golden rule 7.

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

Four packages, version-locked at the C# port version (currently `0.24.5`):

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
currently `0.24.5`), as an **sdist + a universal `py3-none-any` wheel** (pure Python).

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
versioned on the `7.x` line (currently `7.24.5`) in the parent + module poms. Signed with the
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

**The `minor.patch` is CONVERGENT across languages, not lockstepped** (standing policy since
0.24.5): npm, PyPI and NuGet use `0.<m>.<p>` and Maven Central the same `minor.patch` on its
historical major `7` — but a registry only takes a number when it actually publishes. A port with
no changed product file sits the release out and keeps its current version; the next time it ships,
it adopts whatever `minor.patch` is current and skips the gap.

This used to read *"every release bumps all four registries, with version-parity bumps where a port
has no changed file"* — which contradicted the very next sentence. The cross-language *behavior*
contract is the **conformance corpus + [`fixtures/conformance/CAPABILITIES.json`](../fixtures/conformance/CAPABILITIES.json)**:
each release states which capabilities/conformance level it satisfies, and *that* manifest — not a
shared version — is the coordination point. If the shared version is not the coordination point,
then publishing byte-identical content to three registries to keep that version aligned buys
nothing, and the phrase "version-parity bump" appeared ten times in `CHANGELOG.md` paying for it.
(Generated code runs without any MetaObjects runtime, so a language only publishes the libraries it
actually ships: runtime helpers, and codegen where it exists.)

**A lagging version is now information.** PyPI at `0.24.4` while npm is at `0.24.7` says PyPI has
had no product change since `0.24.4`. Under version-parity that was unreadable, because every
registry carried the same number whether or not anything in it had moved.

**One thing this broke, fixed in the same release.** The agent-context staleness nudge assumed the
four registries shared a `minor.patch`. Under convergent publishing a port legitimately sits behind
npm — while `meta agent-docs`, the canonical scaffolder for every port, stamps the npm version it
ran from — so every port nudged a correct setup, and the remedy re-stamped the same newer version:
[#347](https://github.com/metaobjectsdev/metaobjects/issues/347)'s permanently-loud advisory, in all
four ports at once. A context stamped by a **strictly newer** release is no longer treated as stale.
Anything not orderable as a plain `N.N.N` still nudges — prereleases, build metadata, and the
`0.0.0` unresolved-install sentinel — so the "any drift nudges" property is intact.

The opposite failure is **narrowed, not closed**: equal coordinates still assert in-sync, so a port
parked at `24.4` across several npm releases will not be told its context has moved. Settling that
needs the shipped context hashed rather than its version compared, and the JVM ships no
agent-context content — only the manifest reader. Live limitation, recorded here rather than in an
issue nobody reads.

## Public-repo hygiene

This repo is public. Before committing release changes, ensure no local paths or private/consumer
names leak (the `.githooks/pre-commit` guard enforces this — activate with
`git config core.hooksPath .githooks`). See [CLAUDE.md](../CLAUDE.md) → *Public repository hygiene*.
