## What & why

<!-- What does this change do, and why? Link any related issue, e.g. Fixes #123. -->

## Checklist

- [ ] Tests added/updated and passing locally (TDD — test first)
- [ ] For metamodel changes: a **conformance fixture** was added/updated so **all five ports** verify it
- [ ] No new metamodel attribute invented — or, if one is genuinely needed, it's justified, registered, and covered by a `registry-conformance` fixture (ADR-0023)
- [ ] Cross-language wire format & vocabulary preserved (if applicable)
- [ ] Named constants used for metamodel strings; no `any` (TS)
- [ ] **Public-repo hygiene:** no private/other-project names, personal info, or absolute local paths — in code, docs, fixtures, **or commit messages**
- [ ] Docs updated if behavior/CLI changed

## Notes for reviewers

<!-- Anything that needs special attention. -->
