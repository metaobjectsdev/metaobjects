# Conformance Suite Hardening — Review & Remediation Backlog

_Date: 2026-05-29. Status: Review complete; remediation is a ranked backlog (each item gets its own plan when picked up). No code changes in this document._

> **UPDATE 2026-05-31 — conformance-hardening pass A/B shipped; FR-007/R12 rejected.** A fresh
> corpus×port×CI audit drove a two-phase hardening:
> - **Phase A (`db6440ff`)** — wired the byte-exact corpora (render/verify/recover/output-prompt/
>   object-model) into the per-push `conformance.yml` for all 5 ports (incl. a new Kotlin job), and
>   widened `integration-tests.yml` (persistence+api) to run on **all PRs + pushes to main**. Closes
>   the "Kotlin runs only 2 corpora" + "persistence/api not in default CI" + the newly-found
>   "byte-exact corpora run in NO workflow" gaps below.
> - **Phase B (`62521308`, 6 units, all 5 ports)** — the remaining **R6** normalization
>   (timestamp/timestamptz/date/time) is now gated by shared persistence round-trip scenarios
>   (timestamptz-`Z` hazard resolved); **R10** projection holes closed (passthrough-view read +
>   sum/avg/min/max aggregates — only `count` was tested); divergent per-port normalization unit
>   tests retired. B caught a real codegen/normalization bug in every port (proof the behavior
>   corpora gate codegen drift). Spec: `docs/superpowers/specs/2026-05-31-normalization-conformance-design.md`.
> - **R12 (FR-007 codegen-conformance) — REJECTED (re-confirmed 2026-05-31).** Per the 2026-05-26
>   rejection (`docs/superpowers/specs/2026-05-25-fr-007-codegen-conformance-corpus-design.md` §0):
>   a dedicated codegen-output corpus adds ~0 net coverage — the behavior corpora gate codegen's
>   observable consequences, and B proved it empirically. Do NOT build it. See
>   `fixtures/codegen-conformance/README.md`.
> - **Still open (opportunistic, lowest tier):** R10 vocabulary long-tail (`field.short`/`byte`,
>   `validator.*`, non-cascade referential actions, advanced `@kind`s) — closed via the normal
>   "new behavior ⇒ new fixture" discipline, not a campaign. R1 (CLI smoke gate, ties to CLI work)
>   + install-smoke remain.

## Why this exists

A real defect — the **Python port shipped with no CLI** (`meta gen` / `meta verify` / `meta migrate`) — passed every conformance corpus. That prompted a full audit of the conformance suite. The CLI gap is not a one-off; it is the visible tip of a structural blind spot plus several "looks-green-but-isn't-a-gate" issues and broad under-assertion.

**Root cause of the CLI miss:** `spec/conformance-tests.md` scopes the suite to *"Loader behavior"*; codegen and tooling are explicitly out of scope; and every per-port harness invokes the **library** in-process, never the CLI binary. So a port can lack the entire `meta` entry point (Python *and* Kotlin do) and stay green. The CLI was never something conformance *could* catch.

## Corpus inventory (current reality)

Seven fixture directories exist; the governing spec documents only four and omits Kotlin.

| Corpus | Path | Ports running it |
|---|---|---|
| Metamodel (loader) | `fixtures/conformance/` (98 fixtures) | TS, Java, Python, C# |
| YAML | `fixtures/yaml-conformance/` | TS, Java, Python, C# |
| Render | `fixtures/render-conformance/` | TS, C#, Python (Java report-only; **Kotlin none**) |
| template-generator | `fixtures/render-conformance/template-generator/` | TS, Java, Python, C# |
| Verify | `fixtures/verify-conformance/` (31) | TS, Java, Python, C# |
| Persistence | `fixtures/persistence-conformance/` | TS, Java, Python, C#, Kotlin (on-demand, Docker) |
| API-contract | `fixtures/api-contract-conformance/` (20) | TS, Java, Python, C#, Kotlin (on-demand, Docker) |
| codegen | `fixtures/codegen-conformance/` | **does not exist** — README placeholder (FR-007) |

## Findings

### Tier 1 — Fake gates (false confidence; fix first)

These are tests people believe protect them but do not.

1. **Java render conformance is report-only.** `server/java/render/.../RenderCrossPortReportTest.java:97` — *"No assertion — this is a report, not a gate."* It prints drift to stdout and never fails. Java's real check (`RenderSnapshotTest`) compares against Java's **own** snapshots (self-stability), auto-writing them on first run — not against the shared `expected.txt`. So "render is byte-identical across 5 ports" is **unenforced on Java**. (C# `RenderConformanceTests.cs:81` and Python `test_render_conformance.py:93` both assert against the shared file — Java is the outlier.)
2. **Kotlin runs only 2 of 6 corpora** (persistence + api-contract). It runs no render/verify/metamodel/yaml fixtures, yet CLAUDE.md claims render is byte-identical across "…Kotlin…". Kotlin cannot drift on render because it never renders the corpus.
3. **Persistence + api-contract are absent from the default CI test path** for Java/Kotlin/C#: the Java `integration-tests` / `integration-tests-kotlin` modules are excluded from the parent reactor (`server/java/pom.xml`), and C#'s `MetaObjects.IntegrationTests` is not in `MetaObjects.sln`. They run only via the Docker-gated `scripts/integration-test.sh`. A green `mvn test` / `dotnet test` says nothing about those corpora for three ports.
4. **Java metamodel runner: pass-by-accident.** ~~`ConformanceTest.java` (`ensureBriefingRegistered`) mutates the JVM-global singleton registry and depends on **alphabetical fixture ordering**.~~ **✅ RESOLVED 2026-05-29 (ADR-0014, commit `abc44b2d`).** Root cause was deeper than the test: Java's `addChild` validated against the global singleton instead of the loader's registry (unlike TS/Python/C#). Fixed at the core — `addChild` now resolves the owning loader's registry — and the runner composes a per-fixture registry via `setTypeRegistry`, so the provider-extension fixtures are order-independent. See `docs/superpowers/specs/2026-05-29-java-per-loader-registry-design.md`.
5. **YAML corpus diverges by ledger** — C# skips `error-yaml-coerced-hex-in-string`; Java skips `yaml-quoted-leading-zero`. Real library divergences recorded as "known gaps," i.e. the exact looks-green-behaves-differently surface the suite is meant to prevent.

*Verified non-issues:* the stale "85 vs 91" counts are obsolete — the corpus is 98 and all four loader ports run all 98 via directory globbing with empty skip-ledgers. Missing Docker **fails** persistence (no silent skip). Loader runners are not tautological (expected files are hand-authored, shared).

### Tier 2 — Structural blind-spot class (no cross-port gate exists)

Siblings of the CLI gap — a port can silently lack or diverge on these and stay green:

6. **CLI / tooling entry point** — no corpus exercises any `meta` binary / maven-plugin / `dotnet meta`. Python ships none (`server/python` has no `[project.scripts]`, no `cli`/`__main__`); Kotlin ships none (driven only via the Java Maven plugin). Per-port CLI tests (TS, C#) are local, not a shared contract, and can't detect a port that ships no CLI.
7. **Packaging / publish parity** — nothing installs the built/published artifact and runs it. This is the class that hid both the CLI gap and the documented `workspace:*` npm leak.
8. **Codegen output drift** — ~~`fixtures/codegen-conformance/README.md` states drift between ports is undetected... FR-007 plans a *semantic* corpus.~~ **RESOLVED-BY-REJECTION (R12, 2026-05-31):** the framing was wrong — the behavior corpora (persistence/render/api-contract) gate codegen's observable consequences; a `field.currency`/`@maxLength`/missing-generator regression that *matters* explodes there (Phase B empirically caught real per-port codegen bugs that way). A dedicated codegen-output corpus = ~0 net coverage. Only the vocab long-tail no behavior corpus exercises (R10) is a residual gap, closed opportunistically.
9. **Prompt output-parser (FR-006)** — claimed shipped in 5 ports, no corpus. Java even carries a documented origin-resolution deferral that a corpus would surface.
10. **Doc-gen** — providers exist in several ports; no corpus for JSDoc / XML-doc / `COMMENT ON` / Mermaid output.

### Tier 3 — Under-assertion & coverage gaps in existing corpora

11. **Float/double: undefined AND untested wire contract (highest-leverage gap).** `field.float`/`double` → `DOUBLE PRECISION` in all ports (`migrate-ts/.../expected-schema.ts:384` + `emit/postgres.ts:149`; C# `ExpectedSchema.cs:143`; Python `postgres_emit.py:127`), but `persistence-conformance/normalization.md:35` emits `REAL/DOUBLE` as a raw JSON number with **no canonicalization rule** — driver-native double formatting differs across Node/.NET/Python/JVM. Zero persistence rows return a float. A normalization rule (stringify like BIGINT, or a pinned shortest-round-trippable decimal with a worked example) must be **defined before any float fixture can be authored cross-port**.
12. **UUID lowercase-canonical rule is dead contract** — `normalization.md:39` pins it, but no fixture uses a uuid, so C# `Guid` casing/brace-format is never caught. `@generation:uuid`/`assigned` are also never round-tripped at the loader level.
13. **Vocabulary holes (zero fixtures):** `field.{double,float,date,time,short,byte,class}`, `@kind={materializedView,storedProc,tableFunction}`, `template.toolcall`, `validator.{length,regex,numeric,array}`, 12 of 13 `view.*` subtypes, `relationship.aggregation`, `@cardinality:many`, non-cascade `@onDelete`/`@onUpdate`, aggregate `avg/min/max`.
14. **ERR codes with no negative fixture:** `ERR_SUBTYPE_RULE_VIOLATION` (live rule at `subtype-rules.ts:35`, only happy side tested), `ERR_DUPLICATE_NAME`, `ERR_UNKNOWN_TYPE`, `ERR_UNKNOWN_ATTR`, `ERR_INVALID_SUBTYPE_CHILD`, `ERR_MISSING_SUBTYPE`, `ERR_OVERLAY_NO_TARGET`, `ERR_TOP_LEVEL_NOT_OBJECT`, `ERR_PROVIDER_ATTR_CONFLICT`, `ERR_MALFORMED_YAML` (yaml corpus never tests a genuine parse failure, only coercion).
15. **Warnings:** `WARN_*` codes are absent from `ERROR-CODES.json`, so the "every expected code is known" typo-guard can't protect warning codes. Three fixtures still use the loose legacy string-list `expected-warnings.json` (`warning-filterable-no-index`, `warning-filterable-inherited-without-index`, `subtype-entity-missing-primary-warning`) — migrate to the FR5c envelope shape.
16. **Type universe shrinks per corpus** (loader ~9 subtypes → persistence 5 → api-contract 3). Most types are loader-round-tripped but never runtime-tested. `field.object` jsonb/flattened rows, and the `TIMESTAMPTZ` (Z-suffixed) branch, are never exercised at runtime. No shared "kitchen-sink" entity forces consistency.

### Tier 4 — The governing doc is itself a coverage cliff

17. **`spec/conformance-tests.md` is materially stale:** lists 4 ports (no Kotlin) and 4 corpora (missing yaml / api-contract / codegen / template-generator); says Java runs no verify corpus (it does — `VerifyConformanceTest.java`); says codegen is "Drizzle for TS, jOOQ for Java" (Java uses `codegen-spring`). The doc being wrong is *why* the loader-only framing made the CLI gap feel acceptable.

## Remediation backlog (ranked; cheapest mechanism each)

| # | Fix | Tier | Mechanism | Effort |
|---|-----|------|-----------|--------|
| R1 | **CLI smoke gate** — each port exposes `meta` answering `--help`/`gen --dry-run`/`verify`/`migrate --dry-run` against a shared mini-fixture; matching command set + exit codes | 2 | new `fixtures/cli-conformance/` manifest + per-port `scripts/cli-smoke.sh` shelling out | low — **do first; ties to the in-flight CLI work** |
| R2 | **Make Java render a real gate** — `assertEquals` against shared `expected.txt` | 1 | edit `RenderCrossPortReportTest` (or fold into a real assertion) | low |
| R3 | **Refresh `spec/conformance-tests.md`** — 5 ports, 7 corpora, fix Java-verify + Drizzle/jOOQ staleness, reclassify codegen as "semantic parity, byte-equivalence excluded" | 4 | doc edit | low — do early; it's the governing contract |
| R4 | ✅ **DONE (2026-05-29, `cc69ced0`).** `integration-tests.yml` now runs the persistence + api-contract matrix (all 5 ports) on every `pull_request` to `main`, not just release tags / opt-in label — so drift can't merge to main green. | 1 | CI wiring | done |
| R5 | ✅ **DONE (2026-05-29, ADR-0014).** Fixed at the core: Java `addChild` now validates against the owning loader's registry (not the global singleton); runner composes a per-fixture registry. Multi-tenant correctness fix, not just a test cleanup. | 1 | core change + runner refactor | done |
| R6 | ✅ **Plan 1 (float/double fidelity) DONE (2026-05-29).** `normalization.md` REAL/DOUBLE plain-decimal rule + loader fixtures + `field.float`→REAL (float4) distinct from `field.double`→DOUBLE PRECISION in all 5 ports + the `Measurement` persistence entity (cross-port round-trip **and** DDL `REAL`/`DOUBLE PRECISION` type assertions). Commits `4e4a7253` (Java), `163ef5a6` (Kotlin), `fdafa1eb` (Measurement), + earlier TS/C#/Python on the branch. **Plan 2 (uuid fixtures + `@dbColumnType` + timestamptz + jsonb) still pending.** | 3 | `normalization.md` rule + fixtures + uuid | float done; **uuid/`@dbColumnType` → Plan 2** |
| R7 | **Kotlin render runner** (or drop Kotlin from the byte-identical claim in CLAUDE.md) | 1/2 | new Kotlin render-conformance test, or doc edit | low-med |
| R8 | **Register `WARN_*` codes** in `ERROR-CODES.json`; migrate the 3 legacy string-list warnings to FR5c envelope shape | 3 | fixtures + ERROR-CODES.json | low |
| R9 | **Add missing negative fixtures** for the live ERR codes (finding #14), starting with `ERR_SUBTYPE_RULE_VIOLATION` | 3 | fixtures | med |
| R10 | **Fill vocabulary holes** — fixtures for the untested subtypes/attrs (finding #13); a jsonb-without-objectRef negative; a TIMESTAMPTZ row; a JSONB-row persistence scenario | 3 | fixtures | med |
| R11 | ✅ **DONE (2026-05-29, `42f2e0ae`).** Kotlin query runner globs the corpus minus a deferral ledger (allowlist removed) — new fixtures auto-run. Verified 9/9 via Testcontainers. | 1 | refactor Kotlin persistence runner | done |
| R12 | ❌ **REJECTED (2026-05-26, re-confirmed 2026-05-31).** FR-007 codegen-conformance — a codegen-output corpus adds ~0 net coverage; the behavior corpora gate codegen's observable consequences (Phase B proved it: real per-port codegen bugs were caught by persistence round-trip). Do NOT build. The residual vocab-hole tail is R10/opportunistic. See `fixtures/codegen-conformance/README.md`. | 2 | — | n/a |
| R13 | **Prompt output-parser corpus** + **install/run smoke per port** | 2 | sibling corpora / CI smoke | med |

## Scope notes

- This document is a **review + backlog**, not an implementation plan. Each R-item is taken through its own plan when scheduled.
- **R1 (CLI smoke gate) is the direct fix for the exemplar** and should be coordinated with the in-flight CLI work so the gate lands alongside the Python (and Kotlin) CLI rather than after.
- Priority spine: **R1 → R2 → R3 → R4** (close the exemplar + fix the fake gates + correct the governing doc), then R5–R8 (correctness + the float contract), then R9–R13 (coverage breadth).
- The meta-lesson: **conformance's "shared source of truth" promise is only as strong as (a) the corpora a port actually runs through real entry points and (b) the explicitness of each fixture's assertions.** Several gaps here are not missing fixtures but missing *gates* — green that proves nothing.
