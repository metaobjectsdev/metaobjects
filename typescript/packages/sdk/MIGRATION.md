# @metaforge/sdk migration status

**Status**: In flux — build broken pending v0.2 migration.

## What's broken

`@metaforge/sdk` was built under Foundations on top of `@metaobjects/metadata` v0.1.0, which exposed Zod schemas (`Entity`, `Field`, `Identity`, etc.) as the metadata representation.

`@metaobjects/metadata` v0.2.0 (per v0.2 SP1) replaced this Zod-based architecture with a Java-pattern-aligned runtime model (`MetaModel` class + `TypeRegistry` + `parseJson` + `Loader`). The Zod `Entity` schema is gone.

The SDK's record types (`EntityRecord`, `DecisionRecord`, `ConventionRecord`, `GlossaryRecord`, `FailureRecord`, `PrincipleRecord`) all reference the old `Entity` schema directly. **`bun run build` in this package will fail until the records are rewritten on top of `MetaModel`.**

## What's NOT broken

The SDK's storage layer (`storage/read.ts`, `write.ts`, `list.ts`, `lifecycle.ts`), path resolution (`paths.ts`), and config (`config.ts`) don't depend on `Entity` and would survive a record-system migration intact.

## Migration scope (follow-up sub-project)

Rewriting the records on top of `MetaModel` is its own scoped piece of work. Open questions to resolve in that work:
- Are records still useful at all? Per v4 strategy §1, the descriptive-memory record types (decision, convention, glossary, failure, principle) are de-prioritized below the three pillars (codegen, runtime, drift). The entity record specifically may be unnecessary in v0.2 since `MetaModel` itself is the entity representation.
- If records survive: do they wrap `MetaModel` directly, or carry orthogonal metadata (provenance, confidence, lifecycle status) that overlays on top of a model?
- Storage layout: does `.meta/memory/entity/*.json` change format? (Foundations spec §3 had an entity record format — SP2 codegen needs to know what authoring shape to read.)

See [v4 strategy §9 open questions](../../docs/strategy/2026-05-09-northstar-v4.md#9-open-questions) and [v0.2 spec §12](../../docs/specs/2026-05-09-v0.2-ts-pillar.md#12-open-questions) for related context.

## Until migration

- This package's `bun run build` fails. Don't add `packages/sdk` to CI build matrices.
- The package directory remains in the workspace so we don't lose the storage/path/config code that survives.
- v0.1.0 of `@metaforge/sdk` (the Foundations release) is still tagged in git — that version works against `@metaobjects/metadata@0.1.0`.
