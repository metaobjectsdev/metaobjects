# Multi-Persistence Research — Modeling Heterogeneous Backends

**Status:** Design research (no code changed)
**Date:** 2026-08-02
**Amended 2026-08-06** ([#212](https://github.com/metaobjectsdev/metaobjects/issues/212), ADR-0007 Amendment 2): `@role`'s registered vocabulary has since shrunk to `primary | replica` — `index`/`cache`/`publish`/`mirror` are now **reserved-not-registered** (`SOURCE_ROLES` in every port carries only the two survivors), so §1's "already ships the full role vocabulary" claim and the worked `@role: index` / `@role: cache` examples describe the pre-shrink state and are not currently loadable.
**Question:** #248 made persistability derive from "declares a writable `source.*` child" — but that check, the single `dialect`, and the migrate/codegen rails all assume ONE relational store. How should MetaObjects model an object persisted to multiple, heterogeneous backends at once (two RDBs, RDB + search index, document store, KV cache), and how do rails scope to a specific store?

---

## 1. Ground truth: more of this is already decided than the question assumes

The most important research finding is that **the metamodel half of this question was answered in ADR-0007 and is sitting in the repo as accepted-but-staged doctrine.** The design work remaining is not "invent a multi-store model" — it is "realize the accepted model in the rails, and decide the two things ADR-0007 deliberately left open (instance identity and rail scoping)."

What is already on the books:

- **Paradigm subtypes are accepted vocabulary.** ADR-0007 Rule 1: *"Subtype = storage paradigm: `source.{rdb, document, event, keyValue, wideColumn, graph, search, vector, timeSeries, objectStore, api, memory}`"*, with an explicit staging clause: *"Only `source.rdb` is implemented now; the other ten paradigms are a validated roadmap, each built when a backend lands."* The companion design doc (`docs/superpowers/specs/2026-05-23-source-v2-paradigm-subtypes-multisource-design.md`) carries a full catalog: per-paradigm physical attrs (`@collection`, `@index`, `@namespace`, `@topic`…), per-paradigm `@kind` sets with read/write-ness, and per-paradigm field-level physical attrs (`@column` vs `@field` vs `@property`) — deliberately named differently so one multi-sourced field carries several with no collision.
- **Multi-source-per-object is accepted AND partially shipped.** ADR-0007 Rule 4 + `validate-source-roles.ts` enforce exactly-one-`primary`; and `source-constants.ts` **already ships** the full role vocabulary: `primary / replica / index / cache / publish / mirror` (`SOURCE_ROLES`). The design doc's worked example is literally the question's scenario: an entity with `source.rdb @role primary` + `source.search @index @role index` + `source.keyValue @role cache`.
- **The write-through CQRS shape already works today** within one paradigm: writable `rdb[table]` primary + read-only `rdb[view]` replica (#214 read-view codegen).

What is genuinely open:

1. **Rails are single-store.** `migrate-ts` `buildExpectedSchema` takes one `dialect` and walks *all* objects; `codegen-ts` dispatches off `hasWritableRdbSource` / `hasAnyRdbSource` (`source-detect.ts`); the CLI config has one `dialect`.
2. **A latent cross-rail asymmetry in the #248 check itself.** `codegen-ts/source-detect.ts:hasWritableRdbSource` is correctly **paradigm-scoped** (`child.subType !== SOURCE_SUBTYPE_RDB → skip`). But `migrate-ts/expected-schema.ts` (~line 153) checks `c instanceof MetaSource && c.isWritable()` — **paradigm-blind**. Equivalent today (only rdb exists); the day the first `source.document` or `source.search` lands, migrate would emit a phantom `CREATE TABLE` for a document-only or search-only object — precisely the fail-open class #248 just closed for sourceless objects, reopened one axis over. Same class of blindness in `meta-object.ts`'s `tableName` helper (writable+primary, any paradigm). This should be fixed *before* any non-RDB paradigm registers.
3. **Instance identity.** `source.rdb` says "a relational store", not "*which* relational store". Two RDBs at once (operational Postgres + analytics warehouse) is inexpressible in metadata *and* in config.
4. **The `event` paradigm contradiction** (#212): ADR-0007's catalog includes `source.event`, ADR-0028 rules a stream is a channel. #212's resolution (drop `event` from the catalog; model emission at the surface layer; keep the principled "a stream becomes a source exactly when treated as addressable state" escape) is the right call and should be folded into whatever ADR this work produces.
5. **Derivation portability** (#211): projections currently lower to SQL views only; #211 charters "one derivation spec, N lowerings" + an origin × (paradigm, `@kind`) capability matrix with load-time errors.

## 2. Prior art — three patterns that generalize

Surveying JPA persistence-units, Spring Data multi-store, Django DB routers, EF Core multi-DbContext, Prisma, Doctrine multi-EM, and CQRS search-mirroring, three durable patterns fall out:

**P1 — Store-*type* is mapping metadata; store-*instance* is configuration.** Spring Data puts `@Entity` vs `@Document` vs `@Indexed` on the mapping layer (which store *paradigm*), but the connection/instance lives in configuration (a `MongoTemplate` bean, an `EntityManagerFactory`). JPA's persistence-unit, EF Core's DbContext registration, and Django's `DATABASES` all agree: *no mainstream stack puts connection identity in the domain model.* MetaObjects already holds this line (ADR-0001; FR-034's "URL is NOT metadata"; `dialect` in `metaobjects.config.ts`).

**P2 — The routing question is always asked per-(object, store).** Django's router signature is the crispest articulation: `allow_migrate(db, app_label, model)` — "does THIS model participate in THIS store's schema rail?" EF Core asks it implicitly (an entity participates in the migrations of every DbContext that maps it). This is exactly the generalized #248 predicate: persistability is **rail-relative**, not absolute.

**P3 — Mirrors are derived read models maintained at the write path, not second systems-of-record.** The CQRS/search-mirroring pattern (and Spring Data's discouragement of dual `@Entity`+`@Document` on one class as *two masters*) says: one writable system of record; every other store is a *maintained derivation* (index, cache, replica) whose update hook hangs off the canonical write. ADR-0007's role vocabulary (`primary` exclusive; `index/cache/publish/mirror` as secondaries) encodes P3 already; ADR-0045 (generated API surface owns write semantics, above the consumer seam) tells us *where* the maintenance hook belongs in generated code.

## 3. Options

### Option A — Store-type source subtypes (`source.rdb` + `source.search` + `source.document` + `source.kv`)

**Vocabulary impact:** New subtypes — but this is the *already-accepted* ADR-0007 shape, and it is what ADR-0037's procedure independently yields: each paradigm has its own native behavior, driver, and attribute vocabulary (a search index has `@analyzer`/`@mappingsRef`; a KV table has `@partitionKey`/`@ttl`) — the definition of "a thing that owns custom logic" → subtype. Object-kind-within-paradigm stays `@kind` (rdb `view`, document `view`, search `alias`), the chartered structural-variant axis. ADR-0023 cost is real: each registered paradigm needs a provider + `expected-registry.json` entries + conformance fixtures in **all five ports** (loaders must accept the vocabulary everywhere even where only one port grows a rail — the `metaobjects-ui-web` "mirror the spec file, apply in one port" precedent covers this).
**Rail impact:** each rail declares its paradigm; migrate stays the rdb rail; a search-mappings or document-validator rail is a *new sibling rail*, not a migrate mode. Codegen dispatches per paradigm+role.
**Migration path:** perfectly additive. Existing models declare only `source.rdb`; no new subtypes appear in them; output byte-identical.
**RDB + search mirror:** `source.rdb @role primary` + `source.search @index @role index` — first-class, self-documenting, exactly the design doc's worked example.
**#248 generalization:** `isPersistedBy(obj, paradigm)` = declares/inherits a source whose `subType == paradigm` (writable-scoped for write rails). Clean.
**Weakness:** cannot express *two stores of the same paradigm* (two RDBs). The subtype axis identifies the paradigm, not the instance — Option A alone leaves the "two RDBs" case on the floor.

### Option B — Named persistence-target / binding registry

Objects (or sources) bind to named targets `{store-type, dialect, connection…}`; rails are scoped to a target name (`meta migrate --target analytics`).
**Vocabulary impact:** depends critically on *where the name lives*. As a **metadata attr** (`@target: "analytics"` on a source) it is a new attribute per ADR-0037 — and a suspect one: ADR-0023 asks "can it be computed?" — with one target per paradigm it always can (defaulting to the paradigm's sole configured target), so the attr would exist only for the two-same-paradigm case; and it drags deployment topology toward metadata, brushing against P1 and FR-034's "URL is NOT metadata". As **config** it needs zero vocabulary: a `targets` registry in `metaobjects.config.ts` — for which there are *two shipped precedents*: the codegen per-target output-directory registry (named `targets` + per-generator `target`), and FR-025's package-binding shape (convention rule + explicit overrides + pinned resolution order), whose selection primitives (package globs, per-type overrides) transfer directly to "which objects' rdb sources bind to which target".
**Rail impact:** `dialect` becomes the default target's dialect (back-compat: no `targets` block ⇒ one implicit target, today's behavior byte-identical). Migrate ledgers become per-target.
**Migration path:** clean if config-side; existing configs are the degenerate one-target case.
**RDB + search mirror:** expressible but *clumsy alone* — without paradigm subtypes, a target's store-type has no metadata-side anchor, so the model can't say "this entity is search-indexed" portably; the knowledge would live only in one port's config, violating the cross-language spine.
**#248 generalization:** `isPersistedBy(obj, target)` = has a source whose paradigm matches the target's store-type AND that binds (by config resolution) to that target.

### Option C — Capability-based dispatch

Sources/objects declare capabilities; rails ask "supports relational-DDL / full-text / doc-write?".
**Vocabulary impact:** worst of the four. Capabilities as authored metadata invert ADR-0023's provenance discipline — they are *derivable* from paradigm + `@kind` (ADR-0037 step 0: derive, add nothing), so authoring them is redundant state that can drift. As a *derived* internal layer, capabilities are genuinely useful — but that is not a metamodel option, it is an implementation detail of the rails.
**Where it earns its keep:** exactly where #211 already put it — the **origin × (paradigm, `@kind`) capability matrix** with load-time errors ("`origin.first` on a paradigm that can't express argmax → clear error, not silent omission"). Capability is the right *validation* companion to Option A, not a *dispatch* alternative.
**Migration path:** N/A as a primary model.
**Verdict:** fold into A as derived validation; never authored vocabulary.

### Option D — Config-level rail filtering (lightest)

The rail config selects which sources it manages (include/exclude by package/object/role).
**Vocabulary impact:** zero.
**Rail impact:** minimal — a filter in front of today's walk.
**Migration path:** trivially byte-identical (empty filter = everything).
**RDB + search mirror:** cannot express it — there is no search *source* to filter; D can only partition what already exists. It answers "which of my rdb tables does this migrate run own" (useful for, e.g., splitting one model across two databases *by object*), not "this entity also lives in a search index".
**#248 generalization:** `isPersistedBy(obj, rail)` = A's predicate ∧ rail-filter accepts. D is a *component* of B (the selection half of a target binding), not a standalone answer.

## 4. Analysis: these are layers, not alternatives

The options decompose onto orthogonal axes, and each axis already has a home:

| Axis | Question | Answer | Status |
|---|---|---|---|
| Store **paradigm** | "WHAT kind of store holds this object?" | A — `source.<paradigm>` subtypes + `@kind` | **Accepted** (ADR-0007), rdb-only realized |
| Store **relationship** | "system of record, or maintained derivation?" | `@role` (`primary` exclusive; `index/cache/mirror/…`) | **Shipped** vocabulary |
| Store **instance** | "WHICH physical store / connection?" | B-as-config — named `targets` in per-port config | Open; FR-025 + codegen-targets precedents |
| Rail **scoping** | "does THIS object participate in THIS rail?" | the generalized #248 predicate, parameterized by (paradigm, target) — Django's `allow_migrate` shape | Open; today duplicated + asymmetric across migrate/codegen |
| **Feasibility** | "can this derivation lower to this store?" | C-as-derived — #211's capability matrix, load-time errors | Chartered in #211 |

Choosing "A vs B vs C vs D" is a category error: **A is the metamodel, B(-as-config) is the deployment binding, C is the validation layer, D is the selection sub-mechanism inside B.** The genuinely contested call — should instance identity be metadata (`@target` attr) or config? — resolves firmly toward config on three independent grounds: prior art (P1 — no surveyed stack puts it in the model), ADR-0023 (the attr is computable in the overwhelmingly common one-target-per-paradigm case), and the FR-034 boundary ("URL is NOT metadata"). Leave a one-line escape hatch in the ADR: *if* config-side selection (package/object rules) ever proves insufficient to split same-paradigm sources, an optional **logical** `@store` name (config-resolved, never a connection string) may be added by a future ADR — but do not add it speculatively.

## 5. Recommendation — phased

### Phase 0 (now, pre-emptive hardening; zero vocabulary; byte-identical)

1. **Unify the persistability predicate in `@metaobjectsdev/metadata`, paradigm-scoped.** One shared helper — e.g. `MetaObject.writableSources(paradigm?: string)` / `hasWritableSource(paradigm)` (ADR-0039 resolving) — replacing codegen-ts's local `hasWritableRdbSource`/`hasAnyRdbSource` and migrate-ts's inline `instanceof MetaSource && isWritable()` check. **Migrate-ts and `meta-object.ts` `tableName` become explicitly rdb-scoped.** Today this is a refactor with byte-identical output; it converts the latent phantom-CREATE-TABLE bug (§1 item 2) from "will fire the day paradigm two lands" to "cannot fire". Mirror the predicate signature in the other four ports' metadata layers when they next touch this area (their codegen dispatch has the same shape).
2. **Write the ADR** (see §7) pinning: persistability is *rail-relative*; rails are *paradigm-scoped*; instance identity is *config*; capabilities are *derived*. This is cheap now and prevents the next contributor from bolting a second store onto `dialect`.
3. **Resolve #212 inside the same ADR**: amend ADR-0007's catalog to drop `event` as a paradigm (and re-home `publish`'s source-side story at the surface layer), recording the "addressable-state" escape clause. Doing this *before* any paradigm-expansion work keeps the catalog honest.

### Phase 1 (1.x-additive, post-1.0 vocabulary-wise — first non-RDB paradigm)

Land the **first non-RDB paradigm as #211's first slice** — `source.document` or `source.search` (recommendation: **search**, because `@role: index` is the most demanded real-world shape, it exercises the maintained-derivation write path, and it forces the capability matrix immediately). Scope:

- Register the paradigm in all five ports (provider + `expected-registry.json` + conformance fixtures) with its catalog attrs (`@index`, `@mappingsRef`; kinds `index*`/`alias`).
- Generalize `SelectSpec` → derivation spec with per-paradigm lowerings; ship the **capability matrix with load-time errors** (#211 items 1+3).
- The new rail (search-mapping emit/verify) starts **TS-owned**, mirroring ADR-0015's migrate precedent — schema-shaped tooling lives in one engine; per-port runtimes stay data-access.
- Codegen write-path: the `@role: index` maintenance hook is emitted in the generated API surface per ADR-0045 (above the consumer seam), with the *transport* (sync call vs outbox) as consumer-provider config per ADR-0011's retry/fallback precedent — the metadata declares *that* the index is maintained on write, never *how* the write is delivered.
- **ADR-0028 nuance to record:** a projection materialized to a search index needs the "read-only kinds only" rule refined to "no *client-writable* kinds" — a search index is system-maintained but client-read-only, semantically a `materializedView` in another paradigm (#211's own framing). One sentence in the ADR now saves a contradiction later.

Note the deliberate 1.0 posture: ADR-0007 already says paradigms are "built when a backend lands," and the 1.0 vocabulary freeze argues for *not* registering `document`/`search` before GA. Phase 0 carries no vocabulary and is safe now; Phase 1's registration waits for the freeze to lift or for a driving adopter.

### Phase 2 (when a second same-paradigm store is real — named targets)

Add the **config-side `targets` registry**: `targets: { app: { paradigm: "rdb", dialect: "postgres" }, analytics: { paradigm: "rdb", dialect: "postgres", include: ["acme::analytics::*"] } }`, with FR-025's resolution shape (convention + overrides + `unmappedStrategy`, per-object overrides for the "one entity goes elsewhere" case) and the Option-D filter as the selection mechanism. `meta migrate --target <name>`; per-target migration ledgers; `dialect` alone remains the implicit single target (byte-identical). This subsumes the "filter what's passed through" ask and shares its resolver spine with FR-025. **Defer until demanded** — nothing in Phases 0–1 blocks on it, and building it speculatively risks freezing the wrong selection grammar.

### Explicitly out (permanently or until forced)

- Authored capability attrs (Option C as vocabulary) — derived only.
- `@target`/connection identity in metadata — config only, with the ADR-recorded escape hatch.
- Stream/event as a source paradigm — per #212; surface-layer eventing instead.
- Runtime dual-write *consistency machinery* (sagas, outbox implementations) — consumer-provider territory, like retry/fallback (ADR-0011).

## 6. Now-vs-later verdict

**Now:** Phase 0 only — the shared paradigm-scoped predicate (fixes a real latent asymmetry, byte-identical), plus the ADR (including the #212 amendment). Roughly a day of code and a document; it de-risks everything downstream.
**Later (first post-1.0 vocabulary window):** Phase 1 as the implementation FR of #211 — first paradigm + capability matrix + derivation-spec generalization.
**On demand:** Phase 2 named targets, when an adopter actually runs two same-paradigm stores.

## 7. ADR / FR verdict

- **Yes, a new ADR** — working title: *"Persistence rails are store-scoped; persistability is rail-relative; store instances are configuration."* It records the §4 table as doctrine, amends ADR-0007 per #212, adds the ADR-0028 system-maintained-kind nuance, and pins the `@store` escape-hatch clause. This is a durable cross-language, cross-rail contract — squarely ADR material per the project's own rule.
- **The FR is #211, promoted** — #211 is already the correct FR skeleton for Phase 1 (first non-RDB slice + capability matrix); it should absorb this document's rail-scoping requirements rather than spawning a parallel FR. Phase 2 (targets) becomes its own small FR when triggered, explicitly cross-referencing FR-025 for the shared resolver shape.
- **#212** is resolved editorially inside the new ADR (an ADR-0007 amendment), not as separate build work.

## 8. Interactions summary

- **#211:** this design supplies its missing dispatch substrate (paradigm-scoped rails + rail-relative persistability); #211 supplies the derivation/lowering/capability half. Together they are the complete multi-store story for *projections*; this document extends the same substrate to *entities* (the mirror/index/cache roles).
- **#212:** folded in (Phase 0 ADR). Keeping `event` out of the paradigm set shrinks the Phase 1 surface and keeps `isPersistedBy` honest (a topic is not addressable state, so nothing is "persisted by" it).
- **FR-025:** the Phase 2 target resolver deliberately reuses FR-025's convention/override/resolution-order primitive — one binding grammar for "where does this package land in output" and "which store does this object bind to", not two.
- **FR-034 (deferred 1.1):** the ecosystem tier will want to *name* stores as systems; the Phase 2 target names are the natural join point, and keeping instance identity in config keeps FR-034's "URL is NOT metadata" boundary intact.
- **#248:** its principle ("persistability derives from declared sources, never subtype") survives unchanged; this design completes it with the second clause — *…and is evaluated relative to a rail's paradigm (and, later, target).*
