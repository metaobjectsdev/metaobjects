# Reporting vocabulary: what is lowered, what stays inert (FR-044)

Two models that differ ONLY by the FR-044 reporting vocabulary:

- `without/meta.shop.json` — three entities (`Program`, `Purchase`, `WorkoutEvent`).
- `with/meta.shop.json` — the same entities plus their `dimension.*`, `measure.*` and
  `segment.filter` children and three `object.report` nodes. It is the positive
  conformance fixture `fixtures/conformance/reporting-vocabulary/` with one addition:
  `StoreTotals` declares a read-only `source.rdb @kind: view` (rule R5 allows one), because
  a view-backed report passes every source-keyed codegen gate and is the shape most likely
  to leak output.

What is lowered (FR-044 Plan 2): a report that declares a read-only `source.rdb @kind: view`
becomes that view. `StoreTotals` is that report, so `with/` differs from `without/` in exactly
these places and no others:

- TypeScript `meta migrate` proposes one extra statement, `CREATE VIEW v_store_totals`, and the
  `meta docs` agent schema page lists that view (the `## Views` section).
- C# codegen (`dotnet meta gen`) writes one extra file, the keyless row class `StoreTotals.g.cs`, and two extra
  lines in `AppDbContext.g.cs` (a `DbSet` and `HasNoKey().ToView("v_store_totals")`).
- Kotlin codegen (`metaobjects:generate`) writes an Exposed table object for `StoreTotals`.

What stays inert: a report with no read-only source (`ProgramEngagement`, `DailyRevenue`),
everywhere; every generator in TypeScript, Java and Python, for every report; routes, typed
clients, filter allowlists and api-docs in every port; and every other C# and Kotlin generator.
No port but TypeScript emits SQL for a report (ADR-0015), so for Java and Python `with/` and
`without/` still generate byte-identical files. The per-port tests that hold this:

| Port | Test |
|---|---|
| TypeScript | `server/typescript/packages/cli/test/unit/reporting-inert.test.ts` (codegen + migrate) |
| C# | `server/csharp/MetaObjects.Codegen.Tests/ReportingInertTests.cs` |
| Java | `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/ReportingInertTest.java` |
| Kotlin | `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/ReportingInertTest.kt` |
| Python | `server/python/tests/test_reporting_inert.py` |

The documentation tier is held to the same rule (FR-044 Plan 1 ruling), with the one entry
above: `meta docs` model, requirements and site pages and every port's api-docs builder emit
nothing for a report, because its fields are derived by the lowering and a page would show
none of them. Only the agent schema page lists a view-backed report's view. The five tests
above compare that output too.

Regenerate `without/` from `with/` by deleting every `dimension.*`, `measure.*` and
`segment.*` child and every `object.report` node — nothing else may differ.
