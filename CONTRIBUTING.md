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
- For anything non-trivial (new metamodel behavior, a new generator, a cross-language
  change), **open an issue first** to discuss the approach. Small, obvious fixes can go
  straight to a PR.
- MetaObjects is a **public** repository. Never include private/other-project names,
  client names, personal information, or absolute local paths in code, docs, fixtures,
  **or commit messages**. Use generic terms ("a downstream consumer", "a sibling
  project") and repo-relative paths (`<repo-root>`). A local pre-commit hook enforces
  this, and `scripts/ci-local.sh` re-runs the same leak scan over your branch.

## How to contribute a change

1. **Fork** the repo and create a branch from `main`.
2. Make your change following the discipline below — **tests first (TDD)**.
3. Run the gates locally with **`scripts/ci-local.sh --quick`** and make sure it's
   green. **This matters:** nothing in `.github/workflows/` runs any more — see the
   *Local CI* section below.
4. Open a **pull request** against `main` and fill out the PR template.
5. A maintainer runs the full gates locally and approves before merge.

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

### Local CI (this IS the CI — run it before opening/merging a PR)

GitHub Actions is disabled on this repository, so the files in `.github/workflows/`
still describe the checks but no longer run them. They are kept because the switch is
reversible; meanwhile `scripts/ci-local.sh` is what runs them, and it mirrors all three
check workflows:

```bash
scripts/ci-local.sh            # full parity: hygiene.yml's leak-scan, all-port
                               # conformance, the java reactor, the drift/mutation
                               # gates, + integration-tests.yml's docker suite
scripts/ci-local.sh --quick    # hygiene.yml in full + the TypeScript half of
                               # conformance.yml; skips the C#/Java/Kotlin/Python
                               # ports, the java reactor and the docker suite
MO_CI_LIST_ONLY=1 scripts/ci-local.sh --quick   # print the steps, run nothing
```

It SKIPS (loudly, not silently) any port whose toolchain (bun/dotnet/uv/mvn) isn't
installed. The `.githooks/pre-push` hook additionally runs the TS build+typecheck
gate and a Java pom-version drift guard on every push (activate hooks once per
clone: `git config core.hooksPath .githooks`).

If you drive changes through the no-mistakes validation gate, `.no-mistakes.yaml` pins its
`test` step to `scripts/ci-local.sh --only ts-fast --only ts-unit --strict-toolchains` and
its `lint` step to `scripts/ci-local.sh --only gates --strict-toolchains` — together exactly
`--quick`, split so neither step repeats the other's work. `--strict-toolchains` is part of
both: it promotes a SKIP to a FAIL, so a gate host missing bun cannot report green. Those
commands are read from the **default branch**, so editing them on a feature branch has no
effect until it merges.

## Releasing

Maintainers only — see [docs/RELEASING.md](docs/RELEASING.md).

## License

By contributing, you agree your contributions are licensed under the project's
[Apache License 2.0](LICENSE).
