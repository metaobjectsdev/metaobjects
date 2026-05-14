# Conformance fixtures

Cross-language test fixtures land here in Project H2.

Each fixture directory contains:
- `metadata.json` — input metadata declarations
- `expected-parsed.json` — expected Loader output
- `expected-warnings.json` — expected Loader warnings
- `expected-sql/<dialect>.sql` — expected codegen output per dialect (if applicable)

Every language's runtime iterates these fixtures via a conformance test runner. Adding a fixture means BOTH the TS and Java runtimes (when shipped) automatically verify it.

> Populated in Project H2.
