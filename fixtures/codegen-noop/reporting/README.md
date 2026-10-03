# Reporting vocabulary is inert (FR-044 Plan 1)

Two models that differ ONLY by the FR-044 reporting vocabulary:

- `without/meta.shop.json` — three entities (`Program`, `Purchase`, `WorkoutEvent`).
- `with/meta.shop.json` — the same entities plus their `dimension.*`, `measure.*` and
  `segment.filter` children and three `object.report` nodes. It is the positive
  conformance fixture `fixtures/conformance/reporting-vocabulary/` with one addition:
  `StoreTotals` declares a read-only `source.rdb @kind: view` (rule R5 allows one), because
  a view-backed report passes every source-keyed codegen gate and is the shape most likely
  to leak output.

Until a report's lowering lands (Plan 2/3), every generator in every port must emit
byte-identical files for the two models, and TypeScript migrate must propose nothing for
the difference. The per-port tests that hold this:

| Port | Test |
|---|---|
| TypeScript | `server/typescript/packages/cli/test/unit/reporting-inert.test.ts` (codegen + migrate) |
| C# | `server/csharp/MetaObjects.Codegen.Tests/ReportingInertTests.cs` |
| Java | `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/ReportingInertTest.java` |
| Kotlin | `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/ReportingInertTest.kt` |
| Python | `server/python/tests/test_reporting_inert.py` |

Out of scope by decision: the documentation tier (`meta docs` and its peers). It documents
the model as declared, so a report gets a page there; that is documentation of metadata,
not generated code.

Regenerate `without/` from `with/` by deleting every `dimension.*`, `measure.*` and
`segment.*` child and every `object.report` node — nothing else may differ.
