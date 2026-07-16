# Issue #203 — Generated CRUD honors `field.timestamp @autoSet: onCreate|onUpdate` (cross-port)

**Goal:** the generated insert/update/patch stamps `now()` for `@autoSet` timestamp columns, so adopters stop hand-writing `now()` in every repository (~32/62 hand-written repos in one adopter traced to this). `@autoSet` is already a registered attr (`FIELD_ATTR_AUTO_SET`, values `onCreate`/`onUpdate`); the gap is **codegen stamping**.

## Owner contract (from the issue — the spec)
- **insert** stamps EVERY `onCreate` AND `onUpdate` column with `now()` — the model's value is ignored (a fresh row's `updated_at` == its `created_at`).
- **update(model)** stamps `onUpdate` columns with `now()` and **skips `onCreate` entirely** (never rewrites `created_at` — omitting this is the latent lost-update bug).
- **patch(id){…}** stamps `onUpdate` BEFORE the caller's partial block (a partial update still bumps `updated_at`).
- **insertPreserving(model)** — escape hatch writing the `@autoSet` columns verbatim (import/restore/replication). Emitted ONLY for entities that declare `@autoSet` fields.
- `now()` keyed off the COLUMN's temporal type (generalizes beyond Instant).

## Current per-port state (verified 2026-07-16)
- **TS** — DONE via Zod transforms (`zod-validators.ts`): InsertSchema stamps onCreate+onUpdate (`.optional().transform(() => now())`); UpdateSchema omits onCreate, stamps onUpdate. GAP: only `insertPreserving`.
- **Python** — treats `@autoSet` as DB-server-default-filled (optional wire, `entity_model.py`); NO runtime onUpdate stamping. GAP.
- **C# / Java / Kotlin** — no `@autoSet` timestamp stamping in generated CRUD. GAP. (Kotlin's `onUpdate` refs are relationship referential-actions, not `@autoSet`.)

## No existing cross-port gate
The api-contract corpus's `createdAt` is `@required` + caller-supplied — it does NOT gate `@autoSet` stamping. A new gate is needed.

## Plan
1. **Per-port implementation (report-only agents; C#/Java/Python/Kotlin):** each finds its runtime CRUD (repository/ObjectManager insert/update/patch generator) and stamps per the contract + `insertPreserving`, with PER-PORT tests proving: insert→both stamped==now(); update→updatedAt bumped, createdAt unchanged; patch→updatedAt bumped; insertPreserving→verbatim.
2. **TS escape hatch:** add `insertPreserving` (verbatim, skip the autoSet transforms) for entities with `@autoSet` fields.
3. **Shared cross-port gate (I add last, coordinated):** a dedicated `@autoSet` entity + api-contract scenarios (POST stamps created_at==updated_at; PATCH bumps updated_at, leaves created_at) that ALL ports' generated-artifact lanes pass — the parity lock (like #195's coordinated registration).
4. **Cross-port review** for stamping divergence (does every port skip onCreate on update? stamp onUpdate on patch?).

## Discipline
Report-only agents (NEVER `fork` — see [[fork-subagents-go-rogue-use-general-purpose]]); I verify each gate + review + commit per port. Commit to main (forward-only). Named constants (`FIELD_ATTR_AUTO_SET`, `AUTO_SET_ON_CREATE/ON_UPDATE`). Not a release (bundled with #195/#204/#205 per owner).
