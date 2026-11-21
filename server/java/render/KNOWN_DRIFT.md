# Known cross-port render drift (Java vs TS/C#)

This file documents intentional or known whitespace/escaping drift between
Java's render output and the TS-baseline `fixtures/render-conformance/` corpus.

**Within-Java stability** is one build gate (`RenderSnapshotTest`). **Cross-port
byte-equality is now a hard gate too** (`RenderCrossPortReportTest`): every
fixture *not* listed below must be byte-identical to the shared baseline, and
every fixture listed below is asserted to *still* drift — so resolving a drift
here fails the test until its row (and the `KNOWN_DRIFT` set in the test) is
removed. This table is the source of truth for that ledger.

| Fixture | Drift type | Notes |
|---|---|---|

No fixture drifts today. The last row, `render-standalone-tag-stripping` (mustache.java left the line
break after a standalone `{{! comment }}`), was closed by stripping standalone comment lines in
`Renderer` before mustache.java parses (`MustacheTags.withoutStandaloneComments`); the
`render-standalone-consecutive` and `render-standalone-indented` fixtures hold it.

When you find a drift in `RenderCrossPortReportTest` output:
1. Decide if it's worth fixing (most aren't — see FR-004 Java spec §6.4).
2. If documenting: add a row above with fixture name + diff summary.
3. If fixing: adjust `Renderer` / `Escapers` and verify both snapshot test AND
   cross-port report come into agreement.
