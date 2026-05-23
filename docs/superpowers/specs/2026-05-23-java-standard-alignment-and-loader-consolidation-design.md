# Java metamodel standard-alignment & loader consolidation — design

**Date:** 2026-05-23
**Status:** Design (ready for implementation plans)
**Scope:** Bring the Java port onto the cross-language metamodel **standard** (TS is the reference; the conformance corpus is the contract) and simplify its loader. Five work-areas: (WA1) a **case-preserving registry**; (WA2) **`object.entity`/`object.value`** + binding-resolved representation per **[ADR-0005](../../../spec/decisions/ADR-0005-object-representation-binding.md)**; (WA3) **`source.*`** as the only table/view declaration (+ `origin.*`); (WA4) **loader → `metadata` module + simplification**, collapsing the `metadata`/`core` split; (WA5) a **conformance gate** proving the aligned vocabulary loads + canonical-round-trips in Java.

## Background — how Java diverged

Planning the FR-003 projection work (Plan 4a) surfaced that the Java port has drifted from the standard in several connected ways:

- **Object subtypes.** Java registers `object.base`/`object.pojo`/`object.proxy`/`object.mapped`. The standard is exactly `base`/`entity`/`value` (`spec/metamodel.md`). Java conflates the *semantic role* with the *language representation* by encoding representation as the subtype.
- **A stray `@javaRuntime` attribute** (`pojo`/`map`/`proxy`) is *defined in the C# port* (and TS test fixtures) — a Java-specific concept polluting the portable vocabulary, unused by Java, absent in Python, not in the corpus. Cruft.
- **Direct `@dbTable`/`@dbView` attributes on objects** (in `CoreDBMetaDataProvider` + `PojoMetaObject`). The standard declares storage **only** via `source.dbTable`/`source.dbView` child nodes; in TS, objects carry zero db attributes.
- **A case-destroying registry.** `MetaDataTypeId` (and `ChildRequirement`) `toLowerCase()` every type/subtype, so Java **cannot represent** camelCase subtypes (`dbTable`, `dbView`, `dataGrid`) — it would serialize `source.dbview`, **failing** the conformance corpus (which pins `source.dbView`). This is Java-only; TS/C#/Python preserve casing.
- **A `metadata`/`core` module split driven by loader complexity.** TS, C#, and Python all keep file-loading **inside the metadata package**; Java is the outlier (`FileMetaDataLoader` + file-source machinery in a separate `core` module). This split also **blocks the Kotlin metadata facade** (paused on the "Java file-loader core→metadata refactor").

The loader is **already codegen-free** in every port (including Java) — there is no codegen coupling to cut; the issue is module placement + over-engineered file-source ceremony. And `SimpleMetaDataLoader` is **already removed** — the remaining simplification target is the `FileMetaDataLoader`/`FileLoaderOptions`/`FileMetaDataSources` machinery vs. Python's clean `load_directory(dir) → {root, errors, warnings}`.

## Cross-language alignment (what's pinned vs idiomatic)

Per `spec/cross-language-porting-guide.md` and the ADRs: the **durable contract** (conformance) is the *vocabulary* (`object.entity`/`value`; `source.dbTable`/`dbView`; `origin.passthrough`/`aggregate`), the **exact subtype casing**, the canonical serialized form, and observable load semantics. **Idiomatic** (per-port) is the concrete representation classes, discovery mechanism, and internal loader structure. This spec implements **[ADR-0005](../../../spec/decisions/ADR-0005-object-representation-binding.md)** (representation) and honors **[ADR-0001](../../../spec/decisions/ADR-0001-cross-language-type-binding.md)** (binding) for Java; C#/Python adopt ADR-0005 separately.

---

## WA1 — Case-preserving registry (foundational)

**Problem.** `MetaDataTypeId` lowercases `type`/`subType` in its compact constructor (and in `pattern()`/`fromQualifiedName()`); `ChildRequirement` lowercases its `expectedType`/`expectedSubType` match keys. Every registry key + placement rule is therefore case-insensitive-by-destruction, so `dbView`→`dbview`. (The `MetaData` node itself stores `subType` verbatim and compares case-sensitively — the mangling is purely the registry/placement layer.)

**Fix.** Make the registry **case-sensitive on the exact vocabulary**: remove the `toLowerCase()` calls from `MetaDataTypeId` (constructor + helpers) and `ChildRequirement`. Type/subtype names are matched exactly as registered.

**The audit (the real work).** Removing normalization turns previously-tolerated wrong-case usages into hard errors. Audit and fix:
- Any code path that `toLowerCase()`-es a type/subtype before a registry lookup or comparison.
- Any comparison assuming lowercase (most `.equals(SUBTYPE_CONSTANT)` are fine since both sides use the canonical constant — but verify).
- Any **test fixture or metadata file** that authored a type in non-canonical case (e.g. `field.String`, `object.Pojo`) and relied on normalization — re-author to canonical casing.
- The `BaseMetaDataParser` auto-**name** prefix lowercase (lines ~276) is *names*, not subtypes — **leave it**.

**Gate test.** Load a fixture declaring `source.dbView` + `layout.dataGrid`, canonical-serialize, and assert the output preserves camelCase byte-for-byte against the corpus form (`"source.dbView"`, `"layout.dataGrid"`). This is the prerequisite for WA3 (and any camelCase subtype).

**Risk.** Going-forward, metadata must use canonical-cased type/subtype names — this is the contract, but it's a behavior change for any consumer that was sloppy. The fix is contained (`MetaDataTypeId` + `ChildRequirement` + the audit).

---

## WA2 — `object.entity`/`object.value` + binding-resolved representation

Implements **[ADR-0005](../../../spec/decisions/ADR-0005-object-representation-binding.md)**.

**Vocabulary.** Register `object.entity` + `object.value` (semantic); keep abstract `object.base`. **Retire `object.pojo`/`object.proxy`/`object.mapped` as registered subtypes.**

**Representation classes stay, decoupled from subtype.** Keep `PojoMetaObject` (reflection over a bound class), `MappedMetaObject` (Map-backed), `ProxyMetaObject` (interface proxy) as **representation implementations** — they stop self-registering as subtypes.

**Resolution.** Change the object-node instantiation path from a static `(object, subtype)→class` map to: register `entity`/`value` as the subtypes, and at instantiation a **representation resolver** picks the backing implementation class with the ADR-0005 precedence — (1) `@object` inline override → (2) FQN→class binding registry → (3) default (concrete class bound → `PojoMetaObject`; interface bound → `ProxyMetaObject`; **unbound → `MappedMetaObject`/value-object**). **Crucially, the backing instance's `subType` is set to `entity`/`value`** (not `pojo`) so canonical output is `object.entity`/`object.value`.

**Retire `@javaRuntime`.** Ensure Java neither defines nor emits it (Java doesn't today — confirm none leaks in via the resolver). ADR-0005 governs the cross-language retirement (C#/Python sessions handle their side).

**Migration note.** Existing Java metadata/fixtures/tests authored as `object.pojo` must move to `object.entity` (or `value`) — provide a brief migration note; there is **no backwards-compat alias** (project rule: no backwards-compat hacks).

**Open (resolve in planning):** whether `object.base` remains instantiable or is abstract-only; the exact behavior when an `entity` is unbound (Map-backed default vs. a load-time warning); how `@object` distinguishes "FQN class" vs. a representation keyword (recommend: FQN only — keyword representations are derived, not declared).

---

## WA3 — `source.*` as the only table/view declaration (+ `origin.*`)

**Register the persistence vocabulary** (now possible with WA1's casing fix): `source.dbTable` / `source.dbView` (camelCase) with `@name` + optional `@schema`; `origin.passthrough` (`@from`, optional `@via`) + `origin.aggregate` (`@agg` enum count/sum/avg/min/max, `@of`, `@via`). Mirror the `relationship/` new-metatype pattern (provider + node classes), constant names mirroring the TS port. *(This is the Plan-4a work, redone on the correct casing + entity/value foundation, with origin folded in.)*

**Placement (learning from the Plan-4a spike):** the registry does **not** walk the inheritance chain for child-placement at validation time — a child rule must be declared on **each concrete subtype** (or via the mechanism WA1's audit confirms). `source.*` attaches to `object.*` (now `entity`/`value`); `origin.*` attaches to `field.*`. Declare placement on the concrete object/field subtypes accordingly.

**Remove the direct db attrs.** Delete the `@dbTable`/`@dbView` string attributes from objects (`CoreDBMetaDataProvider` object-level registrations + `PojoMetaObject`). Storage is declared **only** via `source.*` children — matching TS (objects carry zero db attrs). `@dbColumn`/`@dbNullable`/etc. on *fields* remain (those are field-level and standard).

**Point OMDB at `source.*`.** `SimpleMappingHandlerDB` already derives a `ViewDef` from a view-name ref; update the table/view derivation to read the object's `source.dbTable`/`source.dbView` **child** (`getSourceName()`/`getSchema()`) instead of the removed `@dbTable` attr. (Origin→view-SQL *derivation* remains FR-003 Plan 4b — out of scope here; WA3 only registers + reads the vocabulary.)

---

## WA4 — Loader → `metadata` + simplification; collapse `core`

**Move file-loading into `metadata`.** Relocate `FileMetaDataLoader`, `FileMetaDataSources`/`LocalFileMetaDataSources`/`URIFileMetaDataSources`, and `FileLoaderOptions` from the `core` module into `metadata` (`com.metaobjects.loader`). Matches TS/C#/Python (file-loading lives in the metadata package) and unblocks the Kotlin metadata facade.

**Simplify toward Python.** Provide a clean primary entry point — `loadDirectory(dir) → LoadResult{ root, errors, warnings }` — and trim the layered `FileLoaderOptions`/`FileMetaDataSources` ceremony to a thin source abstraction + a file list. Keep the proven pipeline (parse → merge/overlay → deferred super-resolution → validation passes → freeze) and the `LoadingState` lifecycle; cut the scaffolding around it.

**Collapse `core` + drop legacy XML.** After the loader moves, `core` holds only legacy XML I/O (`XMLMetaDataReader/Writer`, `XMLObjectReader/Writer`) + `CoreTypeInitializer` + an empty `IOMetaDataProvider`. JSON is the canonical storage format, so **drop the legacy XML I/O** and **collapse `core` into `metadata`**, absorbing `CoreTypeInitializer`. **Re-point the dependents** (`omdb`, `om`, `dynamic`, `codegen-base`/`-mustache`, `maven-plugin`) from `metaobjects-core` → `metaobjects-metadata`. End-state: one `metadata` module owning the type system + loader, matching the other ports.

**Open (verify in planning):** confirm no live consumer needs the XML I/O before deleting it (if one does, keep a minimal `core` for XML only); enumerate the exact dependent POMs to re-point; confirm nothing else lives in `core` that must survive.

---

## WA5 — Conformance gate (prove it loads + round-trips)

A verification task, not new behavior: with WA1–WA4 in, prove the aligned vocabulary is **Java-loadable and canonical-round-trips**. Load fixtures using `object.entity`/`object.value` + `source.dbView`/`dbTable` (camelCase) + `origin.passthrough`/`aggregate`; assert they parse and that canonical serialization preserves the exact subtype casing (matches the corpus form). Where a Java conformance harness + known-gaps ledger exists, move the now-passing `source-*`/`origin-*`/object-vocabulary fixtures off the gap list. (Full corpus parity may still need other vocabulary — note any residual gaps; don't claim more than is proven.)

---

## Sequencing & dependencies

1. **ADR-0005** (written). 2. **WA1** (casing — foundational; everything camelCase depends on it). 3. **WA2** + **WA3** (metamodel — depend on WA1; WA3 also depends on WA2's entity/value for placement). 4. **WA4** (loader — largely independent; can proceed in parallel). 5. **WA5** (gate — last). This is one spec but will yield **several implementation plans** (e.g. casing; object-representation; source/origin; loader-consolidation) rather than one monolith — each independently testable.

## Testing
- **Casing:** load+serialize round-trip preserving `dbView`/`dataGrid` (WA1 gate).
- **Representation:** an `object.entity` with a bound class resolves to reflection access; unbound resolves to Map-backed; `@object` override honored; canonical output is `object.entity` regardless of backing class; `@javaRuntime` never emitted.
- **Source/origin:** fixtures with `source.dbView`/`dbTable`(+`@schema`) and `origin.passthrough`/`aggregate` load + round-trip; OMDB reads table/view from `source.*` children; the removed `@dbTable` attr is rejected.
- **Loader:** `loadDirectory(dir)` loads a multi-file directory → merged/frozen root with errors/warnings; the reactor builds with `core` collapsed into `metadata`.
- **Regression:** the existing metadata + omdb suites stay green (modulo the known pre-existing `CanonicalJsonParserTest` CWD-path errors).

## Out of scope
- **C#/Python implementations** of ADR-0005 (separate sessions, guided by the ADR).
- **Origin→view-SQL derivation + projection codegen** (FR-003 Plan 4b/4c) — now unblocked, but separate; this spec only registers + reads the vocabulary.
- **Down-migration / rename-heuristic convergence** (tracked separately in the FR-003 migration divergences).
- Any new codegen target.

## Cross-references
- ADRs: [ADR-0005](../../../spec/decisions/ADR-0005-object-representation-binding.md) (representation), [ADR-0001](../../../spec/decisions/ADR-0001-cross-language-type-binding.md) (binding), [ADR-0002]/[ADR-0004] (open-closed + provider registration).
- Standard + contract: `spec/metamodel.md`, `spec/conformance-tests.md`, `spec/cross-language-porting-guide.md`.
- Reference ports: TS `server/typescript/packages/metadata/` (vocabulary + loader shape); Python `server/python/` (the simplest loader — `load_directory`); C# `server/csharp/` (carries the `@javaRuntime` cruft to remove).
- Supersedes the Plan-4a approach (`docs/superpowers/plans/2026-05-23-fr-003-plan-4a-source-origin-metamodel.md`) — its source/origin registration is folded into WA3 on the corrected casing + entity/value foundation.
