# Contributing to MetaObjects

Thanks for your interest! MetaObjects is a cross-language metadata standard with five
language ports (TypeScript, C#, Java, Python, Kotlin) kept in lockstep by shared
conformance corpora. This guide covers how to propose changes.

## Before you start

- New here and looking for a place to jump in? Browse the
  [`good first issue`](https://github.com/metaobjectsdev/metaobjects/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  label for low-barrier, well-scoped starting points.
- This is a primarily one-person, part-time project — issues and PRs are welcome, but
  expect reviews on the order of days, not hours.
- Want to maintain a port or an area? [GOVERNANCE.md](GOVERNANCE.md) sets out the roles,
  how merge and publish rights are earned, and how decisions are made.
  [MAINTAINERS.md](MAINTAINERS.md) lists who maintains what today; every port is open.
- For anything non-trivial (new metamodel behavior, a new generator, a cross-language
  change), **open an issue first** to discuss the approach. Small, obvious fixes can go
  straight to a PR.
- MetaObjects is a **public** repository. Never include private/other-project names,
  client names, personal information, or absolute local paths in code, docs, fixtures,
  **or commit messages**. Use generic terms ("a downstream consumer", "a sibling
  project") and repo-relative paths (`<repo-root>`). A local pre-commit hook enforces
  this, and `scripts/ci-local.sh` re-runs the same leak scan over your branch. With a
  private denylist configured, the hooks also refuse a commit (pre-commit) or push
  (pre-push) whose author or committer name or email matches it. Hosted CI cannot see
  the private denylist, so that identity check protects only machines with the hooks
  installed.

## How to contribute a change

1. **Fork** the repo and create a branch from `main`.
2. Make your change following the discipline below — **tests first (TDD)**.
3. Run the gates locally with **`scripts/ci-local.sh --quick`** and make sure it's
   green. On a pull request GitHub Actions runs the leak scan (`hygiene.yml`) and the
   unit and conformance tests of the ports your change touches (`pr-ci.yml`); the docker
   integration suites run on release tags and on manual dispatch — see the *Local CI*
   section below.
4. Open a **pull request** against `main` and fill out the PR template.
5. A maintainer reviews the change and the checks on the pull request before merge. Who can
   approve what, and which changes need a core maintainer, is in
   [GOVERNANCE.md](GOVERNANCE.md#how-decisions-are-made).

## The cardinal rule: the metamodel is the spine

The metamodel vocabulary (types, subtypes, attributes) is identical across all five
ports, enforced by the conformance corpora. **Adding or changing metamodel behavior
means adding/updating a conformance fixture** so every port verifies it — see
[`spec/conformance-tests.md`](spec/conformance-tests.md) and
[`fixtures/conformance/`](fixtures/conformance/).

- **Never invent a metamodel attribute** (ADR-0023). Every accepted attribute must come
  from a registered provider plus a `registry-conformance` fixture. If a generator can
  *derive* something from existing metadata, derive it — don't add an attribute. See
  [`spec/decisions/ADR-0023-strict-metadata-provenance.md`](spec/decisions/ADR-0023-strict-metadata-provenance.md).
- **Preserve the cross-language wire format and vocabulary exactly** — see
  [CLAUDE.md](CLAUDE.md) → *Cross-language porting*.

## Coding discipline

- **TDD** — write the failing test first, then the implementation.
- **Named constants for metamodel strings** — never inline `"field"`, `"object"`, etc.
  (TS: `server/typescript/packages/metadata/src/constants.ts`).
- **No `any` escape hatches** (TS) — use `unknown` and narrow.
- **No backwards-compat hacks.**
- Match the surrounding code's style, naming, and idioms.
- Read an existing generator/port before adding a new one — the patterns are
  intentionally consistent.

## Running tests

```bash
# TypeScript — once, at the repo root:
bun install
cd server/typescript && bun test          # TS server suite (run scoped, never a bare root `bun test`)

cd server/csharp     && dotnet test       # C#
cd server/java       && mvn test          # Java + Kotlin
cd server/python     && pytest            # Python (in its .venv)
```

Cross-language persistence / api-contract corpora (Docker + Testcontainers) run via
`scripts/integration-test.sh`.

Throwaway test databases stay off the drives. The Docker-backed launchers (Postgres, MySQL, the
Cube stack and the `scripts/ci-local.sh` Postgres sidecar) keep each database's data directory on
a size-capped tmpfs with Postgres durability off, and remove the container when the run ends.
The Stryker mutation gate (`bun run conformance:mutation` in
`server/typescript/packages/metadata`, via `scripts/run-stryker.sh`) builds its sandbox under
`$DEV_SCRATCH` when that is set, else the system temp directory, and removes it on exit. Point
`DEV_SCRATCH` at a RAM-backed directory to keep that scratch off disk.

In `server/typescript/packages/codegen-ts`, a new test that needs a temp directory uses `makeScratchDir`
and `removeTree` (`src/scratch-dir.ts`), not `mkdtempSync` and `rmSync(..., { recursive: true })`:
Bun's recursive `rmSync` can fail with `EFAULT` under parallel test load and fail the test.

### Local CI (the checks GitHub runs — run it before opening a PR)

GitHub Actions is enabled on this repository. The check workflows in
`.github/workflows/` are thin wrappers over `scripts/ci-local.sh`, the single
definition of the checks: each wrapper checks out, installs the toolchains its
lane needs, and calls the script, so a local run is the same check a workflow
run would be. A pull request runs the leak scan (`hygiene.yml`) and `pr-ci.yml`, which
runs the unit tests and conformance corpora of only the ports the PR touches (a change
under `fixtures/`, `spec/`, `scripts/`, `.github/`, `agent-context/` or `docs/`, or to any file
outside a port's directory that the selector does not recognise, touches every port; a
change only to the root prose files above runs just the offline gates). Its `pr-ci` job is
green only when every selected lane is, and a newer push cancels the superseded run. The docker integration suites run on release tags and on
manual dispatch. Run the script locally before opening or merging a PR, so nothing red
reaches `main`:

```bash
scripts/ci-local.sh            # full parity: hygiene.yml's leak-scan, all-port
                               # conformance, the java reactor, the drift/mutation
                               # gates, the showcase current in all five ports, +
                               # integration-tests.yml's docker suite
scripts/ci-local.sh --quick    # hygiene.yml in full + the TypeScript half of
                               # conformance.yml; skips the C#/Java/Kotlin/Python
                               # ports, the java reactor and the docker suite
scripts/ci-local.sh --affected # only the lanes this change needs (see below)
MO_CI_LIST_ONLY=1 scripts/ci-local.sh --quick   # print the steps, run nothing
```

**`--affected` runs only what a change can break.** It lists the paths you changed since the
merge base with the base branch (committed, uncommitted and untracked), maps each to lanes
with the table in [`scripts/ci-lane-map.txt`](scripts/ci-lane-map.txt), and prints the lanes it
selected, the lanes it skipped and the rule each path matched, so a reviewer can see what was
not run. A change confined to one port runs that port (`ts-fast` and `ts-unit` for TypeScript
and the web client, `java-slow`, `python`, `csharp`); a change to `fixtures/`, `spec/`,
`scripts/` (the map included), `.github/`, `agent-context/`, anything under `docs/` (port
tests read those pages) or any path no rule claims runs every lane, because unknown means
full; a change to only the root `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `AGENTS.md`
or `CLAUDE.md` runs no lane. It never runs `gates` (`--only gates` does, on every change) and
never the docker half, so a change confined to the Java port skips the Java docker
integration suites, which run on release tags and manual dispatch. When more than one port
is selected their lanes run in parallel, as the full run's do, so a change is never slower
than the full run; one port runs serially. Mutation testing is as before: diff-scoped inside
`ts-fast`. `MO_CI_FULL=1 scripts/ci-local.sh --affected` forces every lane,
`MO_CI_AFFECTED_BASE=<ref>` picks the base, and `scripts/ci-select-lanes.sh [<ref>]` explains
a selection without running anything. The flagless run above is unchanged and is what
[releases](docs/RELEASING.md) use. The same map drives `pr-ci.yml`'s port detection, and
`scripts/test-ci-lane-selection.sh` (in the `gates` lane) pins what each kind of change selects.

The full run does its tree-writing steps first (install, the drift gates, one workspace
build), then runs the rest as parallel lanes: at most `MO_CI_JOBS` at once, default 8. Each
lane's output prints as one block when the lane finishes, so lanes never interleave. The
summary gives every step's time, the slowest steps and each lane's wall time. `--quick` and
`--only` run serially. `MO_CI_PY_WORKERS` (default 8), `MO_CI_TS_WORKERS` (default 6) and
`MO_CI_JVM_FORKS` (default 3) set the worker counts for pytest-xdist, the TypeScript
integration suite and the TypeScript `codegen-ts` conformance suite, and the JVM
integration modules' surefire forks.

It SKIPS (loudly, not silently) any port whose toolchain (bun/dotnet/uv/mvn) isn't
installed. The `.githooks/pre-push` hook additionally runs the identity guard (the
author and committer of every outgoing commit against the private denylist; not skipped by
`SKIP_TS_TYPECHECK=1`), the TS build+typecheck gate and a Java pom-version drift guard on
every push (activate hooks once per clone: `git config core.hooksPath .githooks`).

If you drive changes through the no-mistakes validation gate, `.no-mistakes.yaml` pins its
`test` step to `scripts/ci-local.sh --affected --strict-toolchains` and its `lint` step to
`scripts/ci-local.sh --only gates --strict-toolchains`: the lanes the change affects, then
the gates every change runs, split so the gates run after the build `test` does.
`--strict-toolchains` is part of both: it promotes a SKIP to a FAIL, so a gate host missing
bun (or, for a change to a port, that port's toolchain) cannot report green. Those commands are
read from the **default branch**, so editing them on a feature branch has no effect until it
merges.

## Releasing

Maintainers only — see [docs/RELEASING.md](docs/RELEASING.md).

## License

By contributing, you agree your contributions are licensed under the project's
[Apache License 2.0](LICENSE).
