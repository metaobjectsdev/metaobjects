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
| render-standalone-tag-stripping | trailing newline after `{{! comment }}` | Mustache.java does NOT apply the standalone-line whitespace strip rule to comments — it leaves the trailing newline. TS (`mustache.js`), C# (Stubble), and Python (purpose-built interpreter) all strip it. Symptom: one extra blank line after the comment-standalone block. Same fixture's `{{#section}}`, `{{>partial}}`, etc. standalone-strip correctly in Java. |

When you find a drift in `RenderCrossPortReportTest` output:
1. Decide if it's worth fixing (most aren't — see FR-004 Java spec §6.4).
2. If documenting: add a row above with fixture name + diff summary.
3. If fixing: adjust `Renderer` / `Escapers` and verify both snapshot test AND
   cross-port report come into agreement.
