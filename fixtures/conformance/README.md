# Conformance fixtures

Cross-language test fixtures for the MetaObjects standard. Every language implementation (TS, Java, Python, C#) runs the same fixtures via its own conformance test runner.

Each fixture is a directory:

```
<fixture-name>/
├── input/                       # one or more meta.*.json files
├── expected.json                # canonical metamodel (happy-path)
├── expected-errors.json         # alternative: expected error messages
└── expected-warnings.json       # optional: expected warning messages
```

See [`../../spec/conformance-tests.md`](../../spec/conformance-tests.md) for the full convention.

To add a fixture: create the directory, drop in `input/*.json`, run the test (it auto-discovers), inspect the diff, write the matching `expected.json`.
