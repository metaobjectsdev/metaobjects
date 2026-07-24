# TPH + `@autoSet` controller stamping — cross-port design

**Status:** Approved (2026-07-23). Ready for implementation planning.

**Refs:** #203, #229, [ADR-0045](../../../spec/decisions/ADR-0045-generated-api-surface-owns-write-semantics.md). Follow-up to the vanilla `@autoSet` gate (`46d8e546` Kotlin controller, `abf48d2a` Python router, `c5905b82` the api-contract gate).

## Problem

`field.timestamp @autoSet: onCreate|onUpdate` declares "**the generated CRUD stamps `now()` — the caller does not.**" ADR-0045 established that the *generated API surface* (the REST controller/router an adopter deploys) must own that write semantic — no consumer-supplied seam may sit between the guarantee and the wire. The vanilla-entity legs of that rollout shipped and are gated by `scenarios/autoset-patch.yaml`.

The **TPH (single-table discriminator) write path is a separate code path in every port**, and it did **not** inherit the vanilla fix. A generated TPH base controller/router exposes per-subtype CRUD at `/<base>/<segment>`; those per-subtype create/update handlers were written before the ADR-0045 rollout and stamp inconsistently. No `@autoSet` scenario exists in the TPH corpus, so the divergence ships green — the exact class of hole ADR-0045 §3 diagnosed ("the absence of such an assertion is what let a non-stamping controller ship green").

### Per-port state (verified 2026-07-23)

| Port | Generated TPH per-subtype write path | Stamps `@autoSet`? | Action |
|---|---|---|---|
| **C#** | `RoutesGenerator.GenerateTphRoutes` → `AppendTphSubtypeRoutes` calls `AppendCreateAutoSet` / `AppendUpdateAutoSet` per subtype | ✅ yes | **verify** (expect green) |
| **TS** | per-subtype Zod Insert/Update schemas carry `@autoSet` transforms (`z.string().optional().transform(() => new Date().toISOString())`); `renderZodValidators` / `updateSchemaFields` already handle the `tphPin` | ✅ yes (both halves) | **verify** (expect green) |
| **Java** | `SpringControllerGenerator.emitTph` per-subtype create calls `repository.createWithType(disc, dto)` on a **consumer-implemented interface** with **no** `stampForInsert(dto)` (the vanilla path stamps; the TPH path does not) | ❌ no | **fix** |
| **Kotlin** | `KotlinSpringControllerGenerator.emitTph` per-subtype `insert{}` binds every `writableFields` column straight from the DTO — including `@autoSet` — (and a non-null `@required` autoSet column would NPE on `dto.f!!`) | ❌ no | **fix** |
| **Python** | `router_generator._render_tph_router` per-subtype create/update handlers omit the `create_autoset` / `update_autoset` stamp lines the vanilla `render_router` threads in | ❌ no | **fix** |

> The prior memory note scoped this to "Kotlin/Python." That was reasoned from the vanilla fix (where Java's vanilla path already stamped) and missed that Java's TPH path is a distinct code path that delegates raw. The corrected generated-lane fix set is **Java + Kotlin + Python**; C# and TS are verify-only.

### Settable-set SSOT bug (Java / Kotlin / Python)

Each port derives the per-subtype "settable columns" set once and shares it between the controller (what POST/PATCH may write + validate) and the entity generator (the annotated `<Sub>Validation` / `<Sub>Dto` shape). That SSOT currently does **not** exclude `@autoSet`:

- Kotlin: `KotlinTphPlan.subtypeSettableFields` excludes PK, discriminator, object/map/jsonb-open-bag — but not `@autoSet`.
- Java: `SpringDtoGenerator.settableFields` — same omission.
- Python: the `{Sub}Create` / `{Sub}Patch` model field set — same omission.

Consequence: a server-owned `@autoSet` column is treated as a caller-settable, `@required`-validated field, so a POST without `createdAt` would 400 and a PATCH could overwrite `createdAt`. This must be fixed alongside the stamping so the two stay consistent (the vanilla path already excludes `@autoSet` from its patch-settable set + `_required_field_names`).

## Design

Mirror the vanilla ADR-0045 rollout onto the TPH path, gate-first, cross-port.

### 1. The gate (`fixtures/api-contract-conformance/tph/`)

- Add two `field.timestamp` columns to the TPH **base** `Auth` in `tph/meta.json` (shared by every subtype via `extends`; place after `reference`, before `identity.primary`):
  - `autoCreatedAt` with `@autoSet: onCreate`
  - `autoUpdatedAt` with `@autoSet: onUpdate`
- In `tph/seed.json` (keyed `"auths"`, already holding rows `id:1..3`), add `"autoCreatedAt": "2000-01-01T00:00:00", "autoUpdatedAt": "2000-01-01T00:00:00"` to the seeded rows — at minimum the `Bridge` row `id:1` the scenario PATCHes. The column names + sentinel value are chosen to match the vanilla `seed.json` exactly (which already carries `autoCreatedAt`/`autoUpdatedAt` = `"2000-01-01T00:00:00"` on the Author rows). The corpus seed is loaded by **direct insert**, so the sentinel is planted below the stamping POST path — verify each generated lane's harness seeds from `seed.json` via direct insert (not by replaying create POSTs, which would re-stamp).
- Add `tph/scenarios/tph-autoset-patch.yaml`, mirroring the vanilla `autoset-patch.yaml`:
  - `PATCH /api/auths/bridge/1` with a body touching one ordinary column (`{ "reference": "…" }`).
  - Assert `status: 200` and `fieldsNotEqual: [autoCreatedAt, autoUpdatedAt]`.
  - Rationale: onUpdate bumps to a 2026 `now()`, onCreate is preserved at the 2000 sentinel → the two diverge. One field-vs-field inequality (format- and timing-agnostic) catches **both** failure modes: not bumping `updatedAt`, and the lost-update bug of rewriting `createdAt` on update.

The `fieldsEqual` / `fieldsNotEqual` matchers already exist in every port's api-contract assertion layer (added by the vanilla gate `c5905b82`), so no new matcher vocabulary is needed.

The scenario runs on **both lanes of all five ports** (the `tph/` corpus is auto-discovered by each port's generated + reference harness: `TphGeneratedServerFactory.cs`, `GeneratedTphControllerHarness.{kt,java}`, `generated_tph_app.py`, `api-contract-tph-generated-server.ts`, plus each `Tph*ReferenceServer`). So the gate simultaneously verifies C#/TS and locks the Java/Kotlin/Python fixes.

### 2. Generated-controller fixes

**Kotlin (`KotlinSpringControllerGenerator.emitTph`)** — reuse the vanilla helpers already on the class (`KotlinGenUtil.isAutoSetField` / `autoSetPolicy`, `KotlinTypeMapper.nowExpr`):
- Compute the per-subtype `insertAutoSetFields` / `onUpdateAutoSetFields` from the subtype's effective fields (resolving, so base `@autoSet` columns are included).
- Per-subtype create: remove `@autoSet` columns from the `writableFields` bind loop; capture one `now()` val per temporal type; stamp onCreate + onUpdate columns in the `insert{}`.
- Per-subtype update: `@autoSet` already excluded from `stPatch` (once `subtypeSettableFields` is fixed); bump every `onUpdate` column in the `update{}` on **every** PATCH (drop the "any present" guard when there is an onUpdate column, matching the vanilla path); never rewrite onCreate.
- `KotlinTphPlan.subtypeSettableFields`: add the `@autoSet` exclusion.

**Python (`router_generator._render_tph_router`)** — reuse the vanilla helpers already in the module (`_auto_set_split`, `_auto_set_stamp_lines`, `_auto_set_stamp_expr`):
- Compute `create_autoset` / `update_autoset` per subtype (`_auto_set_split(st.entity)`), thread them into the per-subtype create/update handler bodies exactly as the vanilla `_emit_route_handler` does (stamp onCreate+onUpdate on create; `dto.pop` onCreate + bump onUpdate on update).
- Add `import datetime as _dt` to the TPH module header when any subtype has an `@autoSet` field.
- Confirm the `{Sub}Create` / `{Sub}Patch` models already treat `@autoSet` as optional-on-POST (the vanilla entity-model path does; verify it holds for the TPH subtype models, else fix the settable-set SSOT).

**Java (`SpringControllerGenerator.emitTph`)** — reuse `AutoSetSupport`:
- Per-subtype create: when `AutoSetSupport.hasAutoSetFields(subtype)`, call `<SubDto>.stampForInsert(dto)` before `repository.createWithType(disc, …)` (mirroring the vanilla path's `dtoName.stampForInsert(dto)`).
- Per-subtype update: when `AutoSetSupport.hasOnUpdateFields(subtype)`, stamp onUpdate into the patch before `patchByIdAndType(...)` (mirroring the vanilla `patch.stampAutoSetOnUpdate()`), and ensure onCreate columns are not caller-writable.
- `SpringDtoGenerator.settableFields`: add the `@autoSet` exclusion.

**C# / TS** — no code change expected; the gate is the proof. If either lane reds, it moves from "verify" to "fix" (C#: extend `AutoSetFields`/`AppendTphSubtypeRoutes`; TS: check the TPH route parses through the subtype Insert/Update schema).

### 3. Reference servers + seeds (all five ports)

- Each TPH **reference** server's per-subtype create/update handlers stamp `@autoSet` (they are hand-rolled and must honor the same contract as the generated code — the gate runs both lanes).
- Each **generated**-lane harness seeds the sentinel Bridge row via **direct insert** into the store (not the stamping POST), so `autoCreatedAt == autoUpdatedAt == 2000` survives to be PATCHed — exactly the switch the vanilla gate made.

### 4. No-churn guarantee

A hierarchy with no `@autoSet` field must emit byte-identical TPH output. Pin with the existing per-port snapshot/compile suites (`KotlinAutoSetStampingTest`-style controller-level tests for the generated TPH output; the TS `tph-discriminator` golden; the C#/Java/Python TPH codegen tests). Add a generated-TPH `@autoSet` assertion test per fixed port.

## Verification order

1. Implement the generated-controller fixes (Java, Kotlin, Python) + the settable-set SSOT exclusions, with per-port unit tests.
2. Add the reference-server stamping + direct-insert seeds for all five ports.
3. Add the `@autoSet` columns to the `tph/` base fixture + the sentinel seed.
4. Run all five ports' TPH generated + reference lanes green.
5. **Only then** commit `tph-autoset-patch.yaml` (never land a scenario a lane can't pass).
6. Per-port review + simplify pass before merging forward (the vanilla legs skipped this for context budget; do not skip here).

## Alignment / non-goals

- **ADR-0045**: this is the TPH leg of the same decision — the generated API surface owns the write semantic; persistence-layer stamping stays as defense-in-depth. No new vocabulary; `@autoSet` is an existing registered attr. Output for `@autoSet`-free hierarchies is byte-identical.
- **Not breaking**: additive to generated output for hierarchies that declare `@autoSet`; no metamodel change.
- **Out of scope**: the polymorphic base collection has no create/update route (creates go through `/<segment>`), so only per-subtype handlers are touched. Multi-level TPH beyond the existing corpus's single-level hierarchy is not expanded here. Runtime/repository (non-HTTP) TPH stamping is unchanged.
- **Non-goal — a TPH subtype declaring its OWN `@autoSet` column.** `@autoSet` audit timestamps belong on the shared base entity (the single-table columns every subtype row carries). The three fixed generated ports (Kotlin/Python/Java) compute the stamp set base-scoped, so a subtype-*own* `@autoSet` column is simply never stamped — and, per the `ebf0f1b9` Java gate-alignment fix, never produces non-compiling output (the controller gate matches the base-scoped helper-emission gate). C# gates subtype-resolving but stamps the EF entity property directly (no separately-emitted helper to miss), so it too compiles; it would stamp such a column where the others wouldn't, but the supported + gated pattern is base-owned columns, so behavior is identical for every real hierarchy. Extending stamping to subtype-own `@autoSet` columns (and gating it) is a deliberate future exercise, not this change.

## Risks (all resolved as of the landed implementation)

- ~~C#/TS are expected green but unproven until the gate runs.~~ RESOLVED: both green on both lanes (16/16 each), no generator change needed.
- ~~The generated-lane harnesses must seed the sentinel below any repo-level stamping (hollow-gate trap).~~ RESOLVED + independently confirmed by the final whole-branch review: every lane seeds the 2000 sentinel via direct insert and no harness/consumer-seam hand-stamps `@autoSet`, so a non-stamping controller would fail the gate.
- ~~Excluding `@autoSet` from the settable-set SSOT changes the `<Sub>Validation`/`<Sub>Dto` shape.~~ RESOLVED: the only consumers are the create/patch validation shapes, which correctly no longer require the server-owned column on POST (Python's `{Sub}Create`/`{Sub}Patch` already treated it optional; Kotlin/Java exclude it from the settable set).

## Follow-ups (not part of this change)

- **TPH reference lanes for Java/Kotlin/Python.** TPH currently has a hand-rolled reference lane only for TS/C# (pre-existing corpus coverage). The gate for Java/Kotlin/Python runs on their generated lane only — sufficient for ADR-0045 (it exercises the shipped generated controller). Building the missing reference lanes is a separate "expand TPH two-lane coverage" task.
- **Vanilla (non-TPH) Java `<Entity>Patch` write-once `@autoSet`.** The Java gate-fix implementer found the vanilla non-TPH Java patch path has the same "a PATCH can mutate a write-once `@autoSet` column" bug that the Python port fixed in `7811a9f0`. Out of scope for this TPH change; worth its own fix.
- The C#/TS **reference and generated** stamping reads `now()` per-column on insert rather than from one captured instant (created may differ from updated by a sub-tick). Pre-existing verify-only behavior mirroring the vanilla gate; the TPH scenario PATCHes a pre-seeded row so create-time equality is not asserted cross-port. Worth unifying if the stamping is ever consolidated.
