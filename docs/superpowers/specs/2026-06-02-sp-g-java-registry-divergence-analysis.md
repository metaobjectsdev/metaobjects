# SP-G — Java registry divergence classification (A/B/C/D buckets)

_Analysis only. No code/registration/canonical changes were made. This document
drives the decision of whether to (a) fix Java, (b) expand the cross-port
contract, or (c) treat divergences as out-of-scope._

## Method

The Java registry-manifest emitter (`RegistryManifest.emit`) was run against the
service-loaded `MetaDataRegistry` (the full core + database-extension + common-attr
provider set) and the output diffed structurally against the committed canonical
`fixtures/registry-conformance/expected-registry.json` (the agreed TS/C#/Python
vocabulary). Every divergence below was confirmed by reading the actual Java
registration source — not inferred from the disabled test's Javadoc inventory. In
two places the live emit **corrects** that inventory (noted inline).

The diff is grouped by root cause, then each item is bucketed:

- **(A) Java drift — fix in Java.** Java is wrong vs a settled cross-port concept.
- **(B) Contract gap — canonical/TS should expand.** Java registers a legitimate
  concept the contract arguably should carry. Needs a design decision.
- **(C) Representational/architectural difference.** Java models a concept via a
  different mechanism than the manifest assumes. Needs an explicit decision.
- **(D) Deferred-facet / out-of-v1 noise.** In a facet the manifest deliberately
  excludes; only looks like drift.

---

## Headline findings

1. **The dominant divergence is ONE architectural decision, not dozens of drifts.**
   Java retired the `stringarray` attr subtype and models every array attribute as
   `StringAttribute + .asArray()` (an `@isArray` marker on a `string` attr). Source:
   `AttributeTypesMetaDataProvider.java:55` — literal comment _"StringArrayAttribute
   removed - use StringAttribute with @isArray instead."_ This single choice
   produces **two** families of manifest divergence: `attr.stringarray` missing as a
   registered subtype, **and** every array attr (`fields`, `values`, `columns`,
   `requiredTags`, `requiredSlots`) emitting `valueType: "string"` instead of
   `"stringarray"`. This is **bucket C** (see C-1) and is the single most important
   decision the user must make — it is the one place Java may be _more_ principled
   than TS.

2. **Two structural reserved keywords (`isAbstract`, `isArray`) and a doc attr
   (`description`) are modeled by Java as ordinary per-type attributes.** They are
   registered as real `optionalAttribute` children on the `metadata.base` /
   `field.base` definitions and inherited by every subtype, so they appear as
   "Java-extra" on essentially every type. The contract treats `isAbstract`/`isArray`
   as bare structural keywords (not attrs) and `description` as a `commonAttr`.
   **Bucket C** (C-2, C-3). Note: Java _also_ registers the doc attrs correctly as
   `commonAttrs` — the emitted `commonAttrs` block is **byte-identical** to the
   canonical (all seven: aliases/deprecated/description/notes/replacedBy/seeAlso/
   title). The `description` divergence is a _duplicate_ per-type registration, not a
   missing commonAttr. (This corrects the disabled test's implication that
   `description` is only a per-type attr.)

3. **FR-013 / FR-014 / FR-015 vocabulary is declared in Java's error codes but never
   registered as attrs.** `ErrorCode.java` defines `readOnly` (FR-013),
   `discriminator`/`discriminatorValue` (FR-014), and `parameterRef` (FR-015) error
   codes, but **none** of those attributes are registered on any Java type
   (`grep` for their `optionalAttribute` registration returns nothing). They are
   present in the canonical (TS/C#/Python ship them). This is genuine Java drift —
   **bucket A** (A-2). Likewise `joinEntity`/`joinFields` (M:N join modeling) are in
   the canonical but unregistered in Java, which instead carries a legacy
   `referencedBy`.

4. **The validator vocabulary is PARTIALLY reconciled — the README/test inventory is
   stale here.** Java's `regex` validator now registers **both** `pattern` (cross-port)
   and the legacy `mask`; `array` registers both `min`/`max` (int) and legacy
   `minSize`/`maxSize`. So the SP-C "`@mask` instead of `@pattern`" framing no longer
   holds — `pattern` IS present. What remains: a Java-extra `msg` on every validator,
   legacy `mask`/`minSize`/`maxSize` extras, `length`/`numeric` registering `min`/`max`
   as **string-typed** (canonical: `int`), and `validator.base`/`regex` **missing**
   `min`/`max` that the canonical declares on every validator subtype. **Bucket A**
   (A-1) for the type/legacy items; **bucket B** consideration for `msg` (A-1 note).

---

## Bucket A — Java drift (fix in Java to match the settled contract)

These are concepts TS + C# + Python + a spec/ADR agree on, where Java is simply
behind or wrong. The fix is: change Java registration to match the canonical.

### A-1. Validator vocabulary

| type.subType | Java has | Canonical has | Justification |
|---|---|---|---|
| `validator.base` | (only `msg`, `isAbstract`) | `min:int`, `max:int` | Canonical declares `min`/`max` on the base and every subtype (`MetaValidator.java:38` registers neither). Java should register `min`/`max` on the base. |
| `validator.regex` | `pattern:string`, `mask:string`, `msg`, (no min/max) | `pattern:string`, `min:int`, `max:int` | `pattern` is present (good — README stale); `mask` is a legacy extra to drop; `min`/`max` missing. `RegexValidator.java:44-48`. |
| `validator.length` | `min:string`, `max:string`, `msg` | `min:int`, `max:int` | Wrong value-type — Java declares `min`/`max` as `StringAttribute` (`LengthValidator.java:44-49`); canonical is `int`. |
| `validator.numeric` | `min:string`, `max:string`, `msg` | `min:int`, `max:int` | Same wrong value-type (`NumericValidator.java:45-49`). |
| `validator.array` | `min:int`, `max:int`, `minSize:int`, `maxSize:int`, `msg` | `min:int`, `max:int` | `min`/`max` correct; `minSize`/`maxSize` are legacy extras to drop (`ArrayValidator.java:43-53`). |
| all validators | extra `msg` | — | `msg` (`MetaValidator.ATTR_MSG`) has no canonical peer. Either drop in Java or promote to the contract — see note. |

_Note on `msg`:_ `msg` is a per-validator custom error-message override. It is a
plausibly-legitimate feature (it could be a **bucket B** candidate). But TS/C#/Python
do not register it, and the validator-derived-CHECK-constraint design
(`2026-05-31-validator-derived-check-constraints-design.md`) does not require it.
Recommend dropping in Java unless the user wants it promoted contract-wide.

### A-2. Missing FR-013 / FR-014 / FR-015 + join vocabulary (declared-but-unregistered)

| type.subType | Java | Canonical | Justification |
|---|---|---|---|
| `field.*` (base) | — (no `readOnly`) | `readOnly:boolean` | FR-013 error codes exist in `ErrorCode.java:152-160` but no `optionalAttribute(readOnly)` is registered anywhere. Shipped cross-port (`2026-05-28-fr-013-field-read-only-design.md`). |
| `object.base/entity/value` | — (no discriminator attrs) | `discriminator:string`, `discriminatorValue:string` | FR-014 error codes exist (`ErrorCode.java:177-183`) but the attrs are unregistered. Canonical carries them; `2026-05-28-fr-014-tph-discriminator-design.md`. |
| `source.rdb` | — (no `parameterRef`) | `parameterRef:string` | FR-015 error codes exist (`ErrorCode.java:165-171`); attr unregistered. `2026-05-28-fr-015-source-parameter-ref-design.md`. |
| `relationship.*` | `referencedBy:string` (extra) | `joinEntity:string`, `joinFields:stringarray` | TS registers `joinEntity`/`joinFields` for M:N join modeling (`relationship-schema.ts:41-47`) and has NO registered `referencedBy` (only a derived getter). Java's `referencedBy` (`MetaRelationship.java:43`) is a legacy own-attr with no canonical peer. Java should register `joinEntity`/`joinFields`; `referencedBy` is drift. |
| `identity.secondary` | — (no `unique`) | `unique:boolean` | Canonical (`identity-schema.ts:46`) declares `@unique` on secondary; Java's `SecondaryIdentity` does not register it (and instead emits a stray `generation` inherited from primary — see A-3). |

### A-3. Required-ness and stray-attr drift

Java declares many attrs the contract marks `required: true` as `optionalAttribute`,
because Java enforces required-ness via separate constraints rather than the attr
declaration. The manifest only sees the declaration, so these read as `required:false`:

| type.subType | attr | Java | Canonical |
|---|---|---|---|
| `identity.primary/secondary/reference` | `fields` | optional | **required** |
| `identity.reference` | `references` | optional | **required** |
| `origin.aggregate` | `agg`, `of`, `via` | optional | **required** |
| `origin.collection` | `via` | optional | **required** |
| `origin.passthrough` | `from` | optional | **required** |
| `template.output/prompt/toolcall` | `payloadRef` (+ `toolName`) | optional | **required** |

Plus stray inherited attrs Java leaks onto wrong subtypes (an over-broad base
registration): `identity.secondary` carries `generation` (a primary-only attr);
`origin.base/collection/passthrough` carry `agg`/`of`/`from`/`via` that belong only on
their own subtype; `source.base` carries the full rdb attr set (see C-4). These are
all Java declaring shared attrs too high in its own inheritance chain. **Fix in Java**
by tightening the per-subtype registration to match the canonical's per-subtype
inventory and marking the required attrs required.

### A-4. Missing logical field attrs + value-type mismatches

| type.subType | Java | Canonical | Justification |
|---|---|---|---|
| `field.*` | missing `autoSet`, `filterable`, `sortable`, `sortableDefaultOrder`, `storage` | present | Logical codegen/runtime attrs shipped cross-port (filter/sort = Project D; `storage` = ADR-0007 family). Java never registered them. |
| `field.enum` | `values:string` | `values:stringarray` | Value-type wrong — see C-1 (array modeling). The `@values`/`@enumAlias`/`@enumDoc`/`@coerceDefault`/`@normalize` enum attrs ARE all present in Java (`EnumField.java:165-198`) — only `values`' value-type diverges. |
| `layout.dataGrid` | `columns:string` | `columns:stringarray` | Same array-modeling root cause (C-1). |
| `field.byte`, `field.short` | absent | present | No `ByteField`/`ShortField` in Java (`field/` dir). Canonical (and TS) register them. Either add to Java or — see B-1 — reconsider whether they belong in the contract. |

### A-5. Missing generic `view.*` subtypes

Canonical registers 11 generic input views: `checkbox`, `date`, `dropdown`, `hidden`,
`hotlink`, `month`, `number`, `password`, `radio`, `text`, `textarea`, `web`. Java's
`view/` package ships only `MetaView` (`view.base`) + `CurrencyView` (`view.currency`).
**Fix in Java** by registering the generic view subtypes — _unless_ the view layer is
deemed TS-presentation-only (see B-2).

---

## Bucket B — Contract gap (canonical/TS should expand) — DESIGN DECISIONS

Legitimate concepts where the right fix may be to grow the contract rather than bend
Java. Each needs an explicit decision.

### B-1. `field.byte` / `field.short` — are these contract-worthy?

Java omits them; the canonical includes them. The decision is _which way_ to
reconcile. They are real JVM scalar widths but marginal for a cross-port entity
metamodel (TS/Python have no native `byte`/`short`). If they are vestigial in the
canonical, the higher-value fix is to **remove them from TS + canonical** rather than
add dead subtypes to Java. **Decision needed:** keep (Java adds them) or cut (TS
drops them). Lean: cut, unless a port's codegen actually emits a `byte`/`short` column.

### B-2. The generic `view.*` vocabulary — cross-port or TS-presentation-only?

The 11 input views (checkbox/date/dropdown/…) are a presentation concern. Only TS has
a browser runtime; Java/Python/C# do not render forms. If views are genuinely
cross-port metadata (codegen reads `@defaultView` — and Java DOES have a `defaultView`
field attr, see C-3/D), Java should register the subtypes (A-5). If they are
TS-presentation-only, they belong in the README's "EXCLUDED — legitimately per-port"
list and should be **removed from the canonical**, leaving only `view.base` +
`view.currency` (the two with cross-port semantics). **Decision needed.** This is the
second-most-impactful contract call after C-1.

### B-3. `msg` (per-validator message override)

See A-1 note. If kept, promote to TS + canonical + C# + Python. If not, drop in Java.

---

## Bucket C — Representational/architectural differences — DESIGN DECISIONS

Java models a concept via a genuinely different mechanism. These are not "wrong"; the
manifest schema or Java's model needs an explicit decision.

### C-1. Array attrs: `string + @isArray` (Java) vs a distinct `stringarray` subtype (TS) — **highest-value finding**

**This is the case where Java is arguably MORE correct than TS, and C#/Python merely
followed TS.**

- **TS / canonical:** an array attr is declared with `valueType: "stringarray"`, AND
  there is a registered `attr.stringarray` subtype, AND TS _also_ has an `@isArray`
  structural keyword. So TS carries **two** mechanisms for array-ness (a distinct
  subtype _and_ a structural flag).
- **Java:** deliberately retired `StringArrayAttribute` from the provider chain
  (`AttributeTypesMetaDataProvider.java:55`) and models every array attr as
  `StringAttribute.SUBTYPE_STRING ... .asArray()` — one scalar attr subtype + one
  array flag. `PrimaryIdentity.java:43`, `EnumField.java:165-167`,
  `DataGridLayout.java:52` all use this. The `StringArrayAttribute` class still exists
  but is unwired (dead, like the C#/Python dead constants SP-G already removed).

Java's model is the more orthogonal one: array-ness is a single axis (the `@isArray`
flag) rather than being duplicated as both a flag and a parallel subtype. TS's
`attr.stringarray` is arguably redundant with its own `@isArray` keyword.

**Consequence for the manifest:** Java emits `valueType: "string"` for array attrs and
has no `attr.stringarray` subtype; the canonical expects `valueType: "stringarray"`
plus the subtype. This single difference accounts for ~7 of the value-type mismatches
and 1 of the missing-subtype rows.

**Options:**

1. **Java conforms to TS** — re-wire `StringArrayAttribute`, change all `.asArray()`
   call sites to the `stringarray` subtype. Largest Java blast radius; preserves the
   canonical; but arguably entrenches TS's redundant double-modeling.
2. **TS conforms to Java (canonical changes)** — drop the `attr.stringarray` subtype,
   express array-ness only via `@isArray`, and have the manifest derive
   `valueType` + an `isArray` boolean from the scalar subtype + flag. This is the
   "Java is right" path. Requires regenerating the canonical and reconciling C#/Python.
3. **Manifest-schema decision (recommended for v1):** the manifest's `valueType`
   currently conflates scalar-type and array-ness into one token (`stringarray`). The
   cleaner v1 shape is `{ valueType: "string", isArray: true }` — which both models can
   emit identically (TS reads its subtype/flag; Java reads scalar subtype + `.asArray()`).
   This is a small canonical-schema change that **dissolves the divergence without
   forcing either port to abandon its internal model**, and it is the kind of facet
   the README explicitly says to settle by adjusting the manifest, not by bending a
   port. **Strongest recommendation.**

### C-2. `isArray` modeled as a per-field attr vs a bare structural keyword

`MetaField.java:120/168` registers `@isArray` as a real `optionalAttribute` (boolean)
on `field.base`, inherited by every field subtype → it appears as a Java-extra attr on
all fields. The canonical treats `isArray` as a bare structural keyword (like
`name`/`extends`/`children`), NOT an attr — Java's own `CanonicalJsonSerializer.java:75`
emits it as the bare `isArray` key. So Java has it _both_ ways: a registered attr AND a
bare canonical key. **Decision:** the manifest should exclude structural reserved
keywords (`isArray`, `isAbstract`) from the attrs list by name (a tiny emitter filter),
OR Java should stop registering them as attrs. The former is a manifest-schema decision;
the latter ripples into Java's loader (which validates them as attrs today). Recommend
the emitter-filter (cheap, no Java-behavior change) — pairs naturally with C-3.

### C-3. `isAbstract` + `description` + `defaultView` registered as per-type attrs

Same shape as C-2. `metadata.base` registers `@description` and `@isAbstract` as
`optionalAttribute`s (`MetaData.java:152-153`), inherited everywhere; `MetaField`
additionally registers `@defaultView` (`MetaField.java:117/164`, a view-binding attr
with no canonical peer). The contract: `isAbstract` is a structural keyword;
`description` is a `commonAttr` (which Java _also_ registers correctly — the
`commonAttrs` block matches byte-for-byte); `defaultView` is a Java-only feature attr
(tied to the `view.*` question, B-2). **Decision:** filter the structural keywords +
`description` from the per-type attrs in the manifest emitter (recommended), and decide
`defaultView` under B-2.

### C-4. Attrs declared on the abstract base vs on the concrete subtype

Java declares shared attrs on the abstract base of a family and inherits them down;
the canonical declares them on the concrete subtype and leaves the base empty:

- `source.base` (Java) carries the full rdb attr set (`kind`/`table`/`view`/`schema`/…);
  canonical: `source.base` is empty, attrs live on `source.rdb`.
- `template.base` (Java) carries `format`/`payloadRef`/`owner`/`since`/`requiredTags`/
  `maxChars`/`textRef`; canonical: `template.base` empty, attrs on the concrete
  `prompt`/`output`/`toolcall`.
- `origin.base` (Java) carries `agg`/`of`/`from`/`via`; canonical: `origin.base` empty.

This is the same "declare-on-base vs declare-on-leaf" choice as A-3's stray attrs.
Because the v1 manifest deliberately excludes `inheritsFrom`, the emitter cannot tell
"declared here" from "inherited here" — so a base-declared attr leaks onto the base row
AND (via Java's `getChildRequirements()` returning inherited reqs) onto every subtype.
**Decision:** either (i) Java moves these to the concrete subtypes (matches canonical,
real Java change with loader implications), or (ii) the contract accepts base-level
declaration and the manifest is taught to attribute each attr to its declaring level
(needs `inheritsFrom`, a deferred facet). (i) is cleaner; (ii) reopens a v1 deferral.
Lean (i) but note the cost.

### C-5. `metadata.base` (Java inheritance anchor) vs `metadata.root` only

Java registers BOTH `metadata.base` (the abstract anchor all types inherit from) and
`metadata.root` (the concrete tree root); the canonical registers only `metadata.root`.
`metadata.base` is Java's internal inheritance root (`MetaData.java:147`), conceptually
the same role as TS's implicit base. **Decision:** treat `metadata.base` as an
EXCLUDED per-port inheritance anchor in the manifest (add to the README "EXCLUDED"
list + a one-line emitter skip), OR have the contract acknowledge a base anchor. This
is a near-zero-cost manifest decision — recommend excluding it (it is genuinely the
not-universally-tracked `inheritsFrom` anchor the README already defers).

---

## Bucket D — Deferred-facet / out-of-v1 noise (not real drift)

These are facets the manifest deliberately excludes; they appear in the diff only
because of how Java conflates them, and the emitter mostly already filters them.

### D-1. The parallel physical-DB attr vocabulary

`field.*` (and `object.base`) carry `dbType`/`dbIndex`/`dbLength`/`dbNullable`/
`dbForeignKey`/`dbPrecision`/`dbScale`/`dbUnique`/`dbSequenceName`/`dbIndexName`/
`dbTablespace`/`previousName`. The README's "EXCLUDED — legitimately per-port /
physical" list covers native/physical bindings. **However** — these currently **leak
into the emitted manifest** as Java-extra attrs (the emitter does NOT filter them,
because they are registered as ordinary `attr`-typed child requirements,
indistinguishable from logical attrs without a physical/logical tag). So strictly:

- The _intent_ is bucket D (physical, out of scope).
- The _reality_ is they pollute the manifest, because Java has no "physical" marker on
  the requirement and the contract's physical equivalents are `column`/`db.indexed`/
  `dbColumnType` + logical `maxLength`/`precision`/`scale`/`unique`.

This straddles D and C. **Recommendation:** treat as bucket A/C reconciliation — Java
should converge its physical-attr names onto the cross-port `column`/`db.indexed`/
`dbColumnType` + logical `maxLength`/`precision`/`scale`/`unique` (the
`2026-05-23-persistence-attributes-cross-language-design.md` vocabulary), which both
fixes the manifest AND aligns the persistence layer. The remaining truly-physical Java
extras (`dbSequenceName`/`dbIndexName`/`dbTablespace`/`previousName`/`dbType`) with no
cross-port logical peer should be tagged physical and filtered (a real emitter/registry
change — there is no physical marker today). This is the second-largest Java blast
radius after C-1.

### D-2. `childRules`, `inheritsFrom`, `allowedValues`/default

Confirmed NOT leaking. The emitter (`RegistryManifest.attrsOf`) filters to
`expectedType == "attr"` and non-wildcard names, dropping child-type rules and wildcard
rules; it never reads `allowedValues`/default or `parentType`/`parentSubType`. These
deferred facets are correctly absent from the emitted manifest. No action.

---

## Summary — counts, blast radius, decisions

### Bucket counts (by distinct divergence class)

- **A (Java drift, fix in Java):** validator value-types + legacy extras (A-1);
  unregistered FR-013/014/015 + join + secondary-unique (A-2); required-ness + stray
  base attrs (A-3); missing logical field attrs + enum/dataGrid array value-types
  (A-4); missing generic view subtypes (A-5, pending B-2). ~5 classes spanning ~40
  individual attr rows.
- **B (contract gap, decide):** 3 — `field.byte`/`short` (B-1), generic `view.*`
  (B-2), `msg` (B-3).
- **C (architectural, decide):** 5 — array modeling (C-1, the big one), `isArray` attr
  (C-2), `isAbstract`/`description`/`defaultView` attrs (C-3), base-vs-leaf attr
  placement (C-4), `metadata.base` anchor (C-5).
- **D (deferred-facet noise):** 2 — physical `db*` vocabulary leak (D-1, straddles
  A/C), and correctly-filtered childRules/inheritsFrom/allowedValues (D-2, no action).

### Blast radius of the bucket-A (+ C-4 / D-1) Java fixes

Reconciling Java's metamodel attribute layer touches, in dependency order:

1. **`metadata` module** — the per-type registration classes (`MetaField`,
   `MetaValidator` + 4 validator subclasses, `MetaRelationship`, `MetaObject` family,
   `Source*`, `MetaIdentity` family, `Template*`, `Origin*`, `EnumField`,
   `DataGridLayout`, view subclasses). Plus the loader's **validation phase**, which
   today validates the current attr names — renaming `dbType`→`dbColumnType`,
   adding `readOnly`/`discriminator`/`parameterRef`/`joinEntity`/`joinFields`, fixing
   `min`/`max` value-types, and tightening required-ness all change what the loader
   accepts/rejects. Conformance corpora (`fixtures/conformance/`) must stay green.
2. **`omdb`** — consumes the physical attrs (`dbType`/`dbLength`/`dbNullable`/…) for
   CRUD/codec. Renaming the physical vocabulary (D-1) ripples here directly.
3. **`codegen-spring`** — reads field/object/relationship/source attrs to emit DTOs,
   repositories, filter allowlists; consumes `referencedBy`, the `db*` set,
   `defaultView`. Affected by A-2 (join attrs), A-4 (filterable/sortable/storage), D-1.
4. **`codegen-kotlin`** — same consumption profile as codegen-spring (Exposed tables,
   controllers, payloads); shares the JVM registry, so it sees the manifest change too
   and its own `RegistryManifestConformanceTest` is gated the same way.

The C-bucket "manifest-schema" fixes (C-1 option 3, C-2, C-3 filtering, C-5 exclusion)
have **near-zero Java blast radius** — they change the manifest contract/emitter, not
Java behavior — which is why they are the recommended first move.

### The genuine design decisions the user must make

1. **C-1 array modeling (highest value).** Is `stringarray`-as-a-subtype (TS) or
   `string + @isArray` (Java) the right model? Recommended: change the manifest v1
   schema to `{ valueType, isArray }`, which both ports emit identically and which
   honors Java's more-orthogonal model without a large Java rewrite. **This is the one
   place Java is arguably more correct than TS, and C#/Python only followed TS.**
2. **B-2 generic `view.*`.** Cross-port metadata, or TS-presentation-only (→ remove
   from canonical, keep only `view.base`/`view.currency`)?
3. **B-1 `field.byte`/`short`.** Keep (Java adds) or cut (TS/canonical drop)?
4. **C-4 base-vs-leaf attr placement.** Move Java attrs to concrete subtypes (clean,
   real Java change) or teach the manifest `inheritsFrom` (reopens a v1 deferral)?
5. **D-1 physical `db*` vocabulary.** Converge Java onto the cross-port
   `column`/`db.indexed`/`dbColumnType` + logical names, then tag-and-filter the
   genuinely-physical remainder — needs a physical/logical marker that does not exist
   on Java's `ChildRequirement` today.
6. **C-2/C-3/C-5 structural-keyword + anchor filtering.** Adopt a small emitter filter
   for `isArray`/`isAbstract`/`description`/`metadata.base` (recommended), or change
   Java to stop registering structural keywords as attrs (loader-rippling).

### Is the canonical right, or did reconciling C#/Python toward TS bake in TS bias?

Mostly right — but **C-1 is a real instance of TS bias.** C#/Python were reconciled to
TS's `stringarray`-subtype model, which double-models array-ness (a distinct subtype
_plus_ an `@isArray` keyword). Java independently concluded the subtype is redundant and
removed it. That is a principled simplification, not drift. The recommendation is to
resolve C-1 by adjusting the **manifest schema** (`{valueType, isArray}`) so neither the
TS internal model nor the Java internal model has to capitulate — and to record that
Java surfaced a genuine TS over-modeling. Every other A/B/C item is either Java behind
on shipped cross-port features (A), a presentation/scalar-breadth scoping call (B), or a
mechanism difference best absorbed by the manifest schema or a per-port-anchor exclusion
(C-2/C-3/C-5) — none of which suggests the canonical's _logical_ vocabulary is wrong.

### Recommended reconciliation shape

1. **First, cheap manifest-schema settling (no Java behavior change):** adopt
   `{valueType, isArray}` (C-1 option 3); filter `isArray`/`isAbstract`/`description`
   structural-keywords from per-type attrs (C-2/C-3); exclude the `metadata.base`
   anchor (C-5). Regenerate the canonical from TS, reconcile C#/Python. This alone
   removes the largest swath of "divergence" without touching Java's loader/codegen.
2. **Then, real Java reconciliation (gated, conformance-green):** register the missing
   logical attrs (A-2 FR-013/014/015 + join + secondary-unique; A-4
   filterable/sortable/storage/autoSet); fix validator value-types + drop legacy
   `mask`/`minSize`/`maxSize` (A-1); fix required-ness + tighten base-vs-leaf placement
   (A-3/C-4); converge the physical `db*` names (D-1). Decide B-1/B-2/B-3 first since
   they determine whether Java adds or the canonical cuts.
3. **Re-enable** `RegistryManifestConformanceTest` (drop `@Ignore`/`@Disabled`) once
   the gate is green, in both `metadata` and `codegen-kotlin`.
