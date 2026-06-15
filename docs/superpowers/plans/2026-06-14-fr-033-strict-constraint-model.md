# FR-033 (revised) — Strict per-subtype constraint model + concern-provider split

_Status: DESIGNED (brainstormed + approved 2026-06-14). Revises the FR-033 plan
(`2026-06-13-fr-033-provider-definitions-as-data.md`) and spec
(`docs/superpowers/specs/2026-06-13-metamodel-self-description-design.md`)._

## Why this revision

The first Phase-2 pass (commits `a72f8bb2`..`e08218db`) made each provider's
metamodel definition *data*, but in a **loose** shape:

- every field attr was lumped into the **core** provider (`@maxLength`/`@objectRef`/
  `@filterable`/`@example`/… all on *every* field subtype);
- the wildcard **"any attr"** child rule (`{type:"attr", subType:"*", name:"*"}`)
  was registered on every type — a catch-all that accepts a misplaced/typo'd attr;
- structural child rules were **post-assigned in provider code**, not in the data;
- `documentation` got a **bespoke** `commonAttrs` field + `defineCommonAttrsFromData`.

This is the looseness of the post-6.0 Java model. We are moving to the **pre-6.0
strict** model: each type/subtype declares **exactly** which children it allows
(by type + subtype + name + cardinality), it is **fail-closed**, and the *checking*
runs in `validate()`. Goal triad: **strict** (kills drift) + **documentable** (the
rules ARE the docs) + **extensible** (concerns ride their own providers; additive
merge only — a provider/app can ADD rules, never loosen).

The committed data files + descriptions are **reusable**; the structure is reworked.

## Decisions

1. **Strict per-subtype rules.** Each `type.subType` declares its allowed children
   explicitly. The **"any attr" wildcard is removed**. Genuinely-open *structural*
   sets stay wildcard (an `object.entity` holds arbitrary `field.*`; a field takes
   any `validator.*`/`view.*`/`origin.*`). Cardinality is pinned where there's
   structure (`identity.primary` max 1; an object's primary `source` exactly 1).
2. **Attrs are named `attr` children.** A child rule with a concrete name = a
   specific allowed attr (→ `AttrSchema`); there is no wildcard-attr rule anymore.
3. **Common attrs = attr-children of a universal `*.*` entry** in the data, routed
   to the existing common-attr registration by the **one** apply path. Deletes the
   bespoke `commonAttrs` field + `defineCommonAttrsFromData`.
4. **All child rules live in the JSON, none in provider code.** Shared rules declared
   on `*.base` and inherited via the existing `constraint-merge.ts`; subtype
   specializations on that subtype. The manifest emits **effective (merged)**
   constraints so inheritance is DRY and the canonical does not churn for inherited
   rules.
5. **Enforce in `validate()` now.** A child (attr or structural) not admitted by the
   merged rules → load-time error (new code, e.g. `ERR_CHILD_NOT_ALLOWED`). Data stays
   declarative; the strict checking is code — the pre-6.0 Java split. Complex
   cross-node rules (M:N junction, `@symmetric` self-join, origin path) stay in the
   existing loader validation passes.
6. **Concern-provider split (5).** Only **documentation** is universal (`*.*`); every
   other concern attaches to the specific nodes it is about (DB/XML/etc. are NOT
   universal).

## The 5 concern providers + attr ownership

| Provider | Concern | Owns | Scope |
|---|---|---|---|
| `metaobjects-core-types` *(exists)* | metamodel spine + intrinsic logical shape | type/subtype vocabulary; fields `@default`/`@readOnly`/`@required`, `@maxLength`→string, `@precision`/`@scale`→decimal, `@currency`→currency, `@objectRef`→object, `@values`/`@provided`→enum; objects `@discriminator`/`@discriminatorValue`; identity/relationship/origin structure; `source.rdb` subtype | per node type/subtype |
| `metaobjects-db` *(exists, gains)* | physical storage + DB constraints | fields `@column`/`@db.indexed`/`@dbColumnType` (today) **+ `@storage`→object, `@autoSet`→temporal, `@unique`**; sources `@table`/`@kind`/`@role`/`@schema` | fields + sources (NOT universal) |
| `metaobjects-documentation` *(exists)* | documentation | `@description`/`@title`/`@notes`/`@deprecated`/`@replacedBy`/`@seeAlso`/`@aliases`/`@summary` | **universal `*.*`** |
| `metaobjects-prompt` *(expand `templateProvider`)* | AI + serialization (FR-004/006/010/011) | `template.prompt`/`output`/`toolcall` **type attrs** (`@payloadRef`/`@textRef`/`@format`/`@kind`/…) **moved out of core**; field teaching/extract attrs `@example`/`@instruction`/`@enumAlias`/`@enumDoc`/`@coerceDefault`/`@normalize`/`@xmlText` | fields + `template.*` (NOT universal) |
| `metaobjects-ui` *(new)* | presentation + query surface | fields `@filterable`/`@sortable`/`@sortableDefaultOrder`; `view.*` + `layout.dataGrid` **type attrs** (`@locale`/`@pageSize`/`@columns`/…) **moved out of core** | fields + view/layout (NOT universal) |

Open per-attr calls confirmed: `@autoSet` → date/time/timestamp (all temporal);
`@maxLength` → `field.string` only. `@normalize` lives on `field.enum` (prompt
provider) AND remains the `object.value` default (prompt provider extends
`object.value`).

## Mechanics (foundation changes)

- **`provider-data.ts`**: one apply path. Route a `type:"attr"` child to an
  `AttrSchema` (named) and DROP the wildcard-attr concept; recognize the universal
  `type:"*", subType:"*"` TypeDef and register its attr children via
  `registerCommonAttrs`. Remove `commonAttrs` field + `defineCommonAttrsFromData`.
- **manifest emitter** (`registry-manifest.ts`): emit **effective** (merged via
  `mergeConstraints`) children/attrs per `type.subType` so base-inherited rules show
  on subtypes — keeping the canonical byte-stable while the JSON is DRY. Common
  attrs stay in the `commonAttrs` block (NOT folded into every type's children).
- **`validate()` enforcement**: a placement check against the merged effective
  rules; misplaced/unknown child → new error code. Wire into the loader validation
  phase. Expect to surface + fix existing corpus violations (fail-closed is stricter).

## Implementation sequence (provider-by-provider, reviewed)

- **Phase S0 — foundation.** provider-data routing + universal `*.*` + effective-
  constraint manifest + the `validate()` placement check (enforcement). Prove on a
  trivial provider; keep the canonical byte-stable for unchanged placements.
- **Phase S1 — re-scope core providers strictly.** `field` first (densest; bring the
  per-subtype placement table back for review), then object/attr/validator/identity/
  relationship/source/origin — move shared rules to `*.base`, scope subtype attrs,
  pin cardinalities, drop "any attr". Each its own commit + review; regen canonical.
- **Phase S2 — re-home attrs to the 5 providers.** Expand `templateProvider` →
  `metaobjects-prompt` (template type attrs + field teaching/extract attrs +
  `@xmlText`); create `metaobjects-ui` (view/layout type attrs + filter/sort field
  attrs); move `@storage`/`@autoSet`/`@unique` to `metaobjects-db`. Update
  `coreProviders`. registry-conformance ownership reconciled.
- **Phase S3 — documentation as universal `*.*`.** Replace the bespoke path; canonical
  `commonAttrs` block unchanged.
- **Phase S4 — corpus + enforcement green.** Fix any fixture that placed an attr on a
  now-disallowed subtype; full TS suite + registry-conformance green.
- **Phase S5 — docs-gen + cross-port (Phase 4).** Tiered metamodel docs from the
  strict graph; fan out the read-the-file + strict model to Java/C#/Python/Kotlin
  (Java already has the pre-6.0 model to mirror).

## Invariants throughout

- TS reference goes green at each step; the other four ports stay RED on
  registry-conformance until Phase S5 (documented intermediate state).
- The data files own declarative facts + rule prose; factories, the apply mechanism,
  validation passes, and codegen stay code (ADR-0023 strict provenance preserved;
  no DSL).
- Commit to local `main`; per-provider implementer + two-stage review.
