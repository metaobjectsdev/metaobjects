# Conformance Tests

Cross-language conformance fixtures land in `../fixtures/conformance/` (in H2 — currently empty).

Each fixture is a directory containing:
- `metadata.json` — input metadata
- `expected-parsed.json` — expected typed graph after Loader runs
- `expected-warnings.json` — expected Loader warnings
- `expected-sql/<dialect>.sql` — expected codegen output for projection views (if applicable)

Each language's runtime includes a conformance runner that iterates every fixture and asserts.

> Specification under construction. To be populated in Project H2.
