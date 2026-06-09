# Contributing to MetaObjects

Thanks for your interest! MetaObjects is a cross-language metadata standard with five
language ports (TypeScript, C#, Java, Python, Kotlin) kept in lockstep by shared
conformance corpora. This guide covers how to propose changes.

## Before you start

- For anything non-trivial (new metamodel behavior, a new generator, a cross-language
  change), **open an issue first** to discuss the approach. Small, obvious fixes can go
  straight to a PR.
- MetaObjects is a **public** repository. Never include private/other-project names,
  client names, personal information, or absolute local paths in code, docs, fixtures,
  **or commit messages**. Use generic terms ("a downstream consumer", "a sibling
  project") and repo-relative paths (`<repo-root>`). A CI `leak-scan` job and a local
  pre-commit hook enforce this.

## How to contribute a change

1. **Fork** the repo and create a branch from `main`.
2. Make your change following the discipline below — **tests first (TDD)**.
3. Run the relevant test suite locally; make sure it's green.
4. Open a **pull request** against `main` and fill out the PR template.
5. CI must pass and a maintainer must approve before merge.

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
`scripts/integration-test.sh` and in CI.

## Releasing

Maintainers only — see [docs/RELEASING.md](docs/RELEASING.md).

## License

By contributing, you agree your contributions are licensed under the project's
[Apache License 2.0](LICENSE).
