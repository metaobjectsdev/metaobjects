# Reporting vocabulary: what is lowered, what stays inert (FR-044)

Two models that differ ONLY by the FR-044 reporting vocabulary:

- `without/meta.shop.json` — three entities (`Program`, `Purchase`, `WorkoutEvent`).
- `with/meta.shop.json` — the same entities plus their `dimension.*`, `measure.*` and
  `segment.filter` children and four `object.report` nodes. It is the positive
  conformance fixture `fixtures/conformance/reporting-vocabulary/` with these additions:
  - `StoreTotals` declares a read-only `source.rdb @kind: view` (rule R5 allows one), because
    a view-backed report passes every source-keyed codegen gate and is the shape most likely
    to leak output.
  - `ProgramCatalogue` declares `@spine: "Purchase.program"` and a report `@filter`, and lists
    `programKey`, a dimension over `Program.id` reached by `@via: "Purchase.program"`. It
    declares no source, so it is inert like the other sourceless reports.
  - The ratio `avgDaysPerStarter` declares `@default: 0`. Only the sourceless
    `ProgramEngagement` lists it, so no served output moves.

What is lowered (FR-044 Plan 2): a report that declares a read-only `source.rdb @kind: view`
becomes that view. What is served (FR-044 Plan 3): that same report gets a keyless read-only
REST surface. `StoreTotals` is that report, so `with/` differs from `without/` in exactly
these places and no others:

- TypeScript `meta migrate` proposes one extra statement, `CREATE VIEW v_store_totals`, and the
  `meta docs` agent schema page lists that view (the `## Views` section).
- TypeScript codegen (`meta gen`) writes the report's read-only files and one barrel export:
  `StoreTotals.ts` (Drizzle view binding, Zod read schema, row type, descriptor, filter and sort
  allowlists), `StoreTotals.queries.ts` (the list query only), `StoreTotals.routes.ts` and
  `StoreTotals.routes.hono.ts` (GET list, `POST` answers 405, no `/:id` route) and
  `StoreTotals.names.ts`. From the client UI tier it writes the list hook `StoreTotals.hooks.ts`
  and its descriptor `StoreTotals.meta.ts` and nothing else (no grid, grid hook or form).
- TypeScript `cube-model` (FR-044 Plan 4, opt-in; not a served-report file) writes the Cube
  data-model files `model/cubes/Purchase.yml` (with `StoreTotals`'s rollup),
  `model/cubes/WorkoutEvent.yml` and `model/cubes/Program.yml` (a join-target cube: Purchase's
  `@via` dimensions read its fields). It writes them from the entity vocabulary, so it writes
  them whichever reports are served, and writes nothing for `without/`. The sourceless reports
  add nothing to any cube. `WorkoutEvent.yml` holds the defaulted ratio `avgDaysPerStarter` as
  `COALESCE(…, 0)`: it is a measure of that entity, whichever report lists it.
- C# codegen (`dotnet meta gen`) writes three extra files: the keyless row class
  `StoreTotals.g.cs`, `StoreTotalsRoutes.g.cs` (GET list, `POST` answers 405, no `{id}` route)
  and `StoreTotalsFilterAllowlist.g.cs`; and two extra lines in `AppDbContext.g.cs` (a `DbSet`
  and `HasNoKey().ToView("v_store_totals")`).
- Java codegen (`metaobjects:generate`) writes four extra files, one per generator:
  `StoreTotalsDto.java`, `StoreTotalsRepository.java` (`list` and `count` only),
  `StoreTotalsFilterAllowlist.java` and `StoreTotalsController.java`.
- Kotlin codegen (`metaobjects:generate`) writes four extra files, one per generator:
  `StoreTotalsTable.kt` (the Exposed table object, bytes unchanged from Plan 2),
  `StoreTotals.kt` (the row data class), `StoreTotalsFilterAllowlist.kt` and
  `StoreTotalsController.kt`.
- Python codegen (`metaobjects gen`) writes four extra files, one per generator:
  `StoreTotals.py` (the Pydantic row model), `store_totals_filter_allowlist.py`,
  `store_totals_router.py` and `store_totals_names.py`.
- Documentation: `meta docs` writes a model page per report (all four, the three sourceless
  ones marked "Not served"), lists them under `## Reports` on the model index, adds a
  "Reporting" section to the pages of `Purchase` and `WorkoutEvent`, and writes one API page,
  for `StoreTotals`. Every other port's api-docs builder gains exactly the `StoreTotals` page.

What stays inert: a report with no read-only source (`ProgramEngagement`, `DailyRevenue`,
`ProgramCatalogue`), in
every generator, migration and runtime (its only output is the model page above); the client
UI tier for every unserved report, and every port's client tier but the TypeScript list hook
(no other port has one). No port but TypeScript emits SQL for a report
(ADR-0015). The per-port tests that hold this:

| Port | Test |
|---|---|
| TypeScript | `server/typescript/packages/cli/test/unit/reporting-inert.test.ts` (codegen + migrate) |
| C# | `server/csharp/MetaObjects.Codegen.Tests/ReportingInertTests.cs` |
| Java | `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/ReportingInertTest.java` |
| Kotlin | `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/ReportingInertTest.kt` |
| Python | `server/python/tests/test_reporting_inert.py` |

The documentation tier is held to "differs by exactly": the five tests above compare the
docs output of `with/` and `without/` and allow only the pages and lines named in the
documentation entry above. The agent UI page names no report, and the agent schema page
lists the view-backed report's view. The site gains a page per report.

Regenerate `without/` from `with/` by deleting every `dimension.*`, `measure.*` and
`segment.*` child and every `object.report` node — nothing else may differ.
