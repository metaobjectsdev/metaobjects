# Design — Flyway output adapter for the shared migrate engine (#192)

**Date:** 2026-08-04
**Issue:** [#192](https://github.com/metaobjectsdev/metaobjects/issues/192)
**ADR of record:** [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md) §3
**Scope:** `migrate-ts` + `cli` (npm only). No metamodel change, no vocabulary change, no
conformance-fixture change, no other port touched — schema is TS-owned (ADR-0015).

## 1. Problem

MetaObjects once shipped Flyway-named migration generation for JVM consumers: the Java
`meta:migrate --flyway` Maven mojo (added in `4ca10dd2`, shipped in Java plugin 7.0.0). ADR-0015
consolidated all migration onto the shared TS engine and **removed** that mojo (`77a5c46a`),
designating a "Flyway-prefix output adapter" on the shared engine as its replacement.

That adapter was never built. `server/typescript/packages/migrate-ts/src` has zero `flyway`
references. `meta migrate` emits only its own `<ts>-<slug>/up.sql` + `down.sql` layout plus a private
ledger table — neither of which a Flyway `flyway_schema_history` boot can consume.

Net effect: a Spring-Boot + Exposed + **Flyway** consumer has **no supported path from metadata to
migrations**, and must hand-author `V<n>__*.sql` to match codegen — the exact practice the project's
own doctrine forbids ("pattern-derivable from metadata = codegen, never hand-code").

This is a **regression**, not a new feature: the capability existed, was removed on the promise of a
replacement, and the replacement never landed.

### Already fixed — not in scope

The issue also asked that the `meta init` scaffold stop telling Flyway consumers to "apply schema
only through `meta migrate`", advice impossible to follow on that stack. **That half shipped in PR
#263** (schema-apply doctrine is now per-stack). This design covers the adapter only.

## 2. Architecture

A **third output adapter**, sibling to the two that already exist:

| Adapter | Layout | Selected by |
|---|---|---|
| homegrown (`write-migration.ts`) | `<ts>-<slug>/up.sql` + `down.sql` | default |
| D1/Wrangler (`write-migration-d1.ts`) | `<seq>_<slug>.sql` + `.down/<same>` | `--dialect d1` |
| **Flyway (new)** | `V<N>__<slug>.sql` + `U<N>__<slug>.sql` | `--format flyway` |

The diff/emit engine is **untouched**. It already produces `{ up, down }`; an adapter only decides
the envelope. This is exactly ADR-0015 §3's model ("the engine generates the up+down SQL once;
pluggable output-format adapters name/lay it out per target"), so the change introduces no new
architectural concept — it fills a slot the ADR already specified.

**Format is orthogonal to dialect.** D1 gets its layout free from `--dialect d1` because D1 *is* a
dialect. Flyway is not: a Flyway shop is still on postgres or sqlite. Hence a separate axis.

## 3. Decisions

### D1 — Integer scan-and-increment versioning

Scan the target dir for the highest `V<N>__`, emit `V<N+1>__`. This is what the removed Java mojo did
(`4ca10dd2`: "scan `flywayDir` for the highest `V<N>__`, increment, emit `V<N+1>__<slug>.sql`") and
what the issue's prior art specifies. It also reuses the D1 adapter's `nextSequence` shape.

Rejected: timestamp versions (`V20260804160212__`). Collision-free across branches without
coordination, but diverges from the documented prior art for no benefit this project has evidence of
needing.

Two scanner requirements that are easy to get wrong:

- **Match `V` only.** A regex of `^[VU](\d+)` would let the generated undo files double-bump the
  counter, so every run would skip a version.
- **Take the leading integer of a dotted version.** Flyway permits `V1.1__`, `V2.0.1__`. An existing
  `V10.5__` must yield `V11__`, not `V1__`.

### D2 — Undo emitted as `U<N>__`, Flyway's own convention

The engine computes down SQL for free. Flyway's documented undo naming is the versioned migration's
name with the leading `V` replaced by `U` (`V3__add_view.sql` → `U3__add_view.sql`).

**Verified externally:** undo is a commercial feature — Flyway **Community ignores `U__` files**
rather than failing on them (sources in §8). So emitting them is safe on Community and becomes live
the moment a shop is on Teams/Enterprise. ADR-0015 §2 already noted this Community/paid split.

Rejected: a `.down/` sidecar dir like D1's. Flyway filesystem locations can scan recursively, so a
subdirectory inside the migrations dir risks being picked up as migrations. Rejected: dropping down
SQL entirely — it discards something already computed, for no gain.

### D3 — Underscore slug sanitization (differs from D1)

Flyway renders the description with underscores as spaces, so `V4__add_program_view.sql` is
idiomatic. The D1 adapter sanitizes to hyphens; the Flyway adapter must not copy that.

### D4 — `--format` flag plus a config key

`--format flyway|default` on `meta migrate`, also settable once in `metaobjects.config.ts`. Flag
overrides config; default is `default`, so existing behavior is untouched.

Rationale: a JVM shop sets it once and forgets, while a one-off generation in another format stays
possible. Flag-only would mean repeating it forever with a forgotten flag silently writing the wrong
layout; config-only would remove the one-off escape.

### D5 — Output directory

`--out-dir` when given, else Flyway's convention `src/main/resources/db/migration`. This mirrors the
existing per-adapter default-fallback pattern: the D1 path already falls back to wrangler's
`migrations_dir` (or `migrations`) when `config.outDir` is still `MIGRATE_DEFAULT_OUT_DIR`.

## 4. Components

1. **`migrate-ts/src/write-migration-flyway.ts`** (new)
   `writeMigrationFlyway({ up, down }, { dir, slug }): Promise<{ upPath, downPath, version }>`.
   Creates `dir` if missing, computes the next version, writes both files with a trailing newline.
   Structurally mirrors `write-migration-d1.ts`.
2. **`cli/src/lib/config.ts`** — add `format: "default" | "flyway"` to `ResolvedMigrateConfig`,
   resolved flag > `metaobjects.config.ts` > `"default"`.
3. **`cli/src/commands/migrate.ts`** — dispatch on `config.format` at **both** `writeMigration` call
   sites (the live-DB/diff path and the offline `runOfflineGenerate` path), plus the refusal matrix
   in §6.
4. **`codegen-ts/src/metaobjects-config.ts`** — typed `migrate.format` config key.

## 5. Data flow

Unchanged through load → diff → emit. `meta migrate baseline --from-db` seeds the snapshot exactly as
today and is format-independent. Only the final write differs:

```
metadata ──► expected schema ─┐
                              ├─► diff ──► emit {up, down} ──► adapter ──► files
snapshot / --from-db ─────────┘                                   │
                                          default ────────────────┤
                                          d1      ────────────────┤
                                          flyway  ────────────────┘
```

## 6. Error handling — detect-and-refuse

Flyway owns apply and history. Generating a migration is ours; applying it is not. These refuse at
generation time with a message naming the Flyway command instead, matching the posture established
by #226/#241 (D1 FK cascade) and #258 (PK move):

| Combination | Refusal reason |
|---|---|
| `--format flyway --apply` | Applying behind Flyway desyncs `flyway_schema_history` → use `flyway migrate` |
| `--format flyway apply-pending` | Same — replaying committed migrations is Flyway's job |
| `--format flyway --rollback` | Our ledger does not exist on a Flyway-managed DB → `flyway undo` (Teams) or roll forward |
| `--format flyway --dialect d1` | D1 has its own Wrangler layout and wrangler transport; the combination is meaningless |

Non-fatal behaviors:

- A missing or empty target dir starts at `V1`.
- Non-migration files, repeatable migrations (`R__`), and `U__` files are ignored by the scanner.
- Engine gaps the diff does not model (triggers, cross-column CHECKs, function-valued defaults, GIN
  array indexes) remain the author's to hand-add. The adapter changes nothing here: it degrades by
  emitting what the engine computed, never by silently dropping it.

## 7. Testing

**Unit — `write-migration-flyway`:** empty dir → `V1`; mixed non-migration files ignored; dotted
versions (`V10.5__`) → `V11`; `U__` files do **not** bump the counter; slug sanitized to underscores;
trailing newline on both files.

**CLI:** the four refusals in §6, each asserting exit code and message; `--format` precedence
(flag > config > default); dir resolution (`--out-dir` vs the Flyway convention default).

**Real-engine gate (required).** Every migrate change in this repo carries it, because a green unit
suite has historically missed this exact class: **emit → apply to a real engine → introspect →
re-diff must be EMPTY.** For this adapter that means generating `V1__`/`V2__` against a real
sqlite/postgres, applying them in order, and asserting the re-diff is empty.

**No-churn:** default-format and D1-format output stay byte-identical. Existing migrate tests must
pass unchanged.

## 8. Sources

- Flyway migration naming and undo semantics —
  [Flyway migrations concepts](https://github.com/flyway/flywaydb.org/blob/gh-pages/documentation/concepts/migrations.md)
- Undo is a paid edition feature; Community ignores `U__` —
  [Rolling Back Migrations with Flyway](https://www.baeldung.com/flyway-roll-back)
- Prior art in-repo: `git show 4ca10dd2` (Flyway option added), `git show 77a5c46a` (mojo removed),
  `docs/superpowers/specs/2026-05-25-codegen-kotlin-design.md` §5.1 (superseded design)

## 9. Out of scope

- The other ADR-0015 adapters (two-file `.up.sql`/`.down.sql`, single-file-with-divider for
  dbmate/goose, Liquibase formatted-SQL). This design deliberately builds only the reference adapter;
  the others become mechanical once the `--format` axis exists.
- Restoring any Java-side migrate goal. Schema stays TS-owned per ADR-0015; JVM consumers run the
  Node `meta` CLI for migration generation.
- Closing the engine's modeling gaps (triggers, cross-column CHECKs, function-valued defaults, GIN
  array indexes). Orthogonal to the output envelope.
