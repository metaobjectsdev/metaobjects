# FR-024 Phase-E Handoff — what remains after the skip-ahead program

_Written 2026-06-12 at the close of Phase B + the skip-ahead program (loader-grammar
slice in all ports, atomic manifest flip, persistence-corpus migration, B4b hard
cutover). Everything below is the honest remainder; everything else shipped._

## Already DONE (do not redo)

- `object.projection` + dotted `Entity.child` extends (ANY depth, type-scoped,
  bare nested names) registered + resolving in ALL FIVE ports; aggregate `@via`
  optional everywhere; `expected-registry.json` flipped atomically (no carve-outs
  remain — the `Fr024Pending`/`FR024_PENDING` reasons are empty lifecycle slots).
- The B4b hard cutover (`ERR_ENTITY_PRIMARY_SOURCE_READONLY`) + ALL legacy-spelling
  migrations (conformance corpus, persistence corpus, TS unit tests, agent-context
  authoring prose).
- Kotlin codegen emits projections (Exposed table + data class); Java identity
  `@fields`-through-inheritance; Java addressing-model fix (bare nested names +
  own-children overlay lookup — retired the MergedSource ledger gap).

## Phase-E work items

1. **Validation-pass parity (the ledgers ARE the spec).** Each non-TS port's
   `conformance-expected-failures.json` lists exactly the error fixtures whose
   validation passes are TS-only: identity name/pass-through/key-correspondence
   (B3), value-purity + projection-licensing (B4a), via inference + cardinality
   (B5), agreement + providability (B6), and the B4b cutover rule. Port each pass
   reading the TS reference (`subtype-rules.ts`, `validate-identity-passthrough.ts`,
   `validation-passes.ts` _deriveBaseEntity/_inferViaSingleHop/_refNamedOwner +
   cardinality + agreement + providability, `validate-source-roles.ts` cutover).
   Un-ledger empirically (fixed-but-listed discipline). NOTE the conservative
   cardinality form (spec §6) and the ref-named-owner anchor rule (the entity
   NAMED in the ref, never the inherited child's declaring ancestor) are part of
   the byte-identical contract.
2. **Projection codegen fan-out** (Phase C defines the TS reference first):
   read-only models + `ProjectionOf<E>` markers + GET-only surfaces per port;
   C# EF keyless-entity mapping for view-backed projections; Java OMDB/Spring +
   Python read models (Kotlin's table/data-class slice already shipped).
3. **Deferred polish:** extends cycle detection through nested children
   (pre-existing Java TODO, reachable via deep paths); per-port unit tests for
   deep traversal (the shared corpus is the gate today); Java parse-time
   file-default-package capture (the ancestry-derivation fallback works but the
   TS-style structural capture is cleaner); the Java identity-name REQUIREMENT
   (ERR_IDENTITY_NAME_REQUIRED — fixture ledgered).

4. **Pre-release review findings (2026-06-13, 5-reviewer adversarial pass — none
   ship-blocking; the cheap doc/comment/test fixes were applied, these remain):**
   - **Java absolute/relative dotted-owner divergence.** `extends:
     "::acme::sales::Customer.id"` (leading `::` absolute) and `"..::X.id"`
     (relative) RESOLVE in TS/C#/Python but FAIL in Java — Java's
     `resolveChildTargetingRef` (MetaDataLoader.java) resolves the owner part
     directly via `getChildOfType` instead of routing it through the
     absolute/relative resolver the other three ports' recursion uses. **Unused
     anywhere** (zero corpus usage of leading-`::`/`..::` for normal OR dotted
     extends; the idiom is unprefixed `a::b::C`), so the green gate doesn't see
     it. Resolution: add a conformance fixture with `::`-absolute and
     `..::`-relative dotted owner refs (it will fail Java → drives the Java fix:
     route ownerRef through `MetaDataUtil.expandPackageForPath` / strip leading
     `::` before lookup). Decide first whether leading-`::` is a supported form
     at all (TS-supported but undocumented).
   - **view-DDL emitter drops `@schema` + emits unquoted identifiers**
     (`codegen-ts/src/projection/view-ddl-emit.ts`). The RFC's oldest deferred
     bug — Phase C must add quoting + schema-qualification before any consumer
     runs the emitted `CREATE VIEW` against a schema-qualified/reserved-word/
     mixed-case target. Cleanly deferred, not half-done.
   - **Array-shape validation permanently disabled** (Java
     `AttributeConstraintBuilder.isArrayValue → true`). Pre-existing dead
     constraint (folded-name lookup always returned null); now reaches a value
     but every value stringifies, so shape can't be checked at that layer. No
     fixture asserts a non-array value in an array slot is rejected. Move the
     check to the typed (StringArrayAttribute) layer in a port-parity pass.

## Sequencing note

Phases C (TS projection codegen + view-DDL quoting/schema fix) and D
(`api.operational`) proceed on the TS reference next, per the program plan;
Phase E consumes their corpora.
