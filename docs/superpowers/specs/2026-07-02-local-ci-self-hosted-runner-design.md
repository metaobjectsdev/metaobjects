# Local CI via self-hosted runner — design

**Date:** 2026-07-02
**Status:** approved (brainstorm)

## Problem

The heavy correctness gates (5-port conformance matrix, full Java reactor, docker
integration suite) were removed from per-PR/per-push hosted CI to cut Actions cost
(`conformance.yml` / `integration-tests.yml` are now tag + `workflow_dispatch`
only). The intended replacement — maintainers running `scripts/ci-local.sh` by
hand before merging — is honor-system, and `main` can go red undetected until
release-tag time. A live example: 2 failing TS tests were found on `main` only
because a manual full-suite run happened during a review.

We want the full gate to run automatically, immediately after every push to
`main`, at zero Actions cost — by executing on a maintainer-controlled Linux
workstation registered as a GitHub self-hosted runner.

## Goals

- A push to `main` triggers a test run within seconds, on the self-hosted runner.
- Typical (single-port) pushes get a verdict in minutes, not tens of minutes:
  only the ports a push touches are tested, and independent port suites run in
  parallel.
- A full everything-matrix still runs nightly and on demand.
- Red runs surface as the normal GitHub red X **plus** a desktop notification on
  the runner machine.
- Zero risk of fork-submitted code executing on the runner (public repo).

## Non-goals

- Gating PRs from forks (no `pull_request` trigger at all — see Security).
- Replacing the hosted tag-triggered workflows; they remain the release backstop.
- Changing what the gates test. This is trigger/orchestration only.

## Design

### 1. Runner topology

- GitHub self-hosted runners registered to **this repository only** (not org),
  labels `self-hosted, linux`.
- **N runner instances** (implementation default: 4) installed side-by-side on
  the same machine, each as a systemd service (`./svc.sh install`), so the
  per-port jobs of one workflow run execute concurrently. A single runner
  instance executes one job at a time; parallel jobs require parallel runners.
- Each runner checks out into its own `_work` directory — fully isolated from
  the maintainer's development working tree.
- Machine-specific setup steps (paths, service names) live with the runner
  installation, not in this repository.

### 2. Workflow: `.github/workflows/local-ci.yml`

Triggers:

```yaml
on:
  push:
    branches: [main]     # never pull_request — see Security
  schedule:
    - cron: '17 8 * * *' # nightly full matrix (UTC)
  workflow_dispatch:
    inputs:
      tier: { full | affected }
concurrency:
  group: local-ci-${{ github.ref }}
  cancel-in-progress: true   # a newer push supersedes a running build
```

Jobs:

1. **detect** — computes the affected-port set from the pushed commit range
   (`github.event.before..github.event.after`; falls back to `HEAD~1..HEAD`).
   Emits boolean outputs per port + a `run-all` output. Schedule and
   `workflow_dispatch tier=full` force `run-all`.
2. **Per-port jobs** (`ts`, `java` (incl. Kotlin), `python`, `csharp`) — each
   `needs: detect`, guarded by `if: needs.detect.outputs.<port> == 'true'`,
   `runs-on: [self-hosted, linux]`. Each job runs
   `scripts/ci-local.sh --only <port> --strict-toolchains`.
3. **gates** — the cheap shared gates (leak-scan, fixture-lint, pom parity,
   drift) run on every push regardless of port selection.
4. **notify** — `needs:` all of the above, `if: failure()`, fires a desktop
   notification (`notify-send`) on the runner machine with the commit subject +
   run URL. The D-Bus address is derived generically
   (`unix:path=/run/user/$(id -u)/bus`); nothing machine- or user-specific is
   committed.

### 3. Change→port mapping (detect rules)

| Paths touched | Ports selected |
|---|---|
| `server/typescript/**`, `client/web/**` | ts |
| `server/java/**` | java (runs Kotlin modules too — same reactor) |
| `server/python/**` | python |
| `server/csharp/**` | csharp |
| `fixtures/**`, `spec/**`, `scripts/**`, `.github/**`, `agent-context/**` | **all ports** |
| only `docs/**` / `**/*.md` | gates only (no port suites) |

Anything not matched by a rule defaults to **all ports** (fail-open to more
testing, never less).

### 4. `scripts/ci-local.sh` extensions

Two additive flags; existing behavior unchanged when neither is passed:

- `--only <ts|java|python|csharp>` — run a single port's build+test+conformance
  section (plus that port's docker integration suite). The workflow becomes a
  thin dispatcher; the *content* of each port's gate stays defined once, in the
  script, shared between CI and by-hand use.
- `--strict-toolchains` — a missing toolchain is a **failure**, not a
  skip-with-warning. Required on the runner so the gate can't silently weaken;
  by-hand runs keep the forgiving default.

### 5. Tiers and expected wall-clock

- **Push (affected)** — single-port commit: that port only, ~3–8 min.
  Cross-port / fixtures / spec commit: all ports in parallel, wall-clock ≈
  slowest port (~8–15 min) instead of the serialized sum.
- **Nightly + dispatch (full)** — everything, identical to today's
  `ci-local.sh` full tier, run as parallel per-port jobs.
- First implementation step is to **measure** a real full run and record actual
  per-port timings in the workflow README comment; the numbers above are
  estimates.

Docker contention between parallel port suites is mitigated by the shared
Postgres sidecar pattern already adopted in hosted CI (`74d67722`); the local
integration script reuses it.

### 6. Security (public repo + self-hosted runner)

- **No `pull_request` trigger, ever, on any workflow targeting the self-hosted
  labels.** Push events to `main` can only be produced by users with write
  access, so fork code cannot reach the runner.
- Repo Actions policy set to *require approval for all outside collaborators*
  (defense-in-depth; affects hosted workflows only, since no PR job targets the
  runner).
- Runners are repo-scoped, so no other repository can schedule jobs onto them.
- `actions/checkout` in runner jobs uses `persist-credentials: false`.

### 7. Failure handling

- Any red job → red workflow → GitHub email (default notification) + the
  `notify` job's desktop popup.
- `cancel-in-progress` means superseded runs are cancelled, not failed; only
  genuine gate failures notify.
- If the machine is offline/asleep, jobs queue and run on wake — the red/green
  lands late rather than never. (Runner offline > 24h: GitHub marks queued runs
  stale; the nightly next-day run still covers `main`.)

## Testing / verification

1. `--only` / `--strict-toolchains` verified by running each flag combination
   by hand and checking section selection + hard-fail on a masked toolchain.
2. Detect rules verified with a table-driven unit test (paths in → port set
   out) if implemented as a script; otherwise by three probe pushes (docs-only,
   single-port, fixtures) observing job selection in the Actions UI.
3. End-to-end: a deliberate red (temporarily failing test on a branch pushed to
   `main` — or `workflow_dispatch` on a known-red commit) must produce the
   desktop notification.

## Rollout

1. Land `ci-local.sh` flags + `local-ci.yml` (workflow is inert until a runner
   with matching labels exists).
2. Register runner instances + systemd services; set the Actions repo policy.
3. Probe pushes; measure and record real timings.
4. Update `CLAUDE.md` (currently claims conformance gates are PR-required via
   branch protection — stale) to describe the actual gate topology: hygiene on
   PR, local-ci on push-to-main, hosted matrix on tags.
