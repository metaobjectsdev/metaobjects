# FR-024 — Entity surfaces: `object.projection`, universal field-`extends`, and the declared API (design)

_Status: DESIGNED (brainstormed + approved direction; needs implementation plan)._
_Date: 2026-06-12._
_Revises: the FR-021 design sketch where it touches contract shapes (operation payloads
referenced `object.value` "projections"; this design gives projections their own subtype).
Resolves: the entity-surfaces / view-projections RFC discussion (2026-06)._

## 1. Problem

One logical entity routinely needs several representations:

1. **Entity table & object** — system of record: full fields, internal names, writable.
2. **Full DB view** — all table columns plus joined/derived columns; reads go through
   the view while writes still target the table (the classic avoid-re-joining pattern).
3. **Versioned API DB view** — e.g. `customers_v1`: a read-only **subset** of columns,
   renamed to a public convention, consumed by external systems.
4. **REST API surface** — routes/DTOs over the entity or one of its views, including
   non-CRUD operations (domain verbs) that today live outside the metadata entirely.
5. **UI grid / list** — an explicit, filterable column set.

These share identity ("it's a Customer") but differ in **which fields are exposed**,
**naming**, **read/write-ability**, and **generated code shape**. Today the metamodel
can express only fragments of this:

- A view projection is spelled `object.entity` + `extends <Entity>` + `source.rdb
  @kind:view` — and `extends` is a **firehose**: the view inherits *every* effective
  field of the entity. There is no subset mechanism, so a renamed-subset API view is
  inexpressible, and field exposure is fail-open (a newly added sensitive field appears
  in every extending view by default).
- `extends`-ing an entity to make a view is also semantically wrong: a view is
  *derived from* an entity (projection-of), not a *subtype of* it (IS-A).
- Prompt payloads (FR-004) spell the same concept — a derived read shape — a second
  way: `object.value` + `origin.*` fields. Two spellings, chosen by accident of which
  feature shipped them.
- The view-DDL emitter neither quotes identifiers nor schema-qualifies (the table-DDL
  emitter does both) — emitted view DDL is invalid against case-sensitive physical
  identifiers.
- Non-CRUD operations and versioned wire contracts have no declared home (the FR-021
  problem; its `api` vocabulary is aligned, not replaced, by this design).

## 2. Design principles (the five layers)

The design decomposes into five concerns that must stay orthogonal. Every mechanism
below does exactly one job:

| Layer | Question | Mechanism |
|---|---|---|
| 1. **Shape taxonomy** | what KIND of thing is this object? | `object.entity` / `object.value` / **`object.projection`** (new) |
| 2. **Inheritance** | where does this field's type/docs/validators come from? | `extends` — **only** `extends`; `origin.*` never inherits |
| 3. **Provenance / assembly** | where does this field's DATA come from, and how is the view assembled? | `origin.*` (`passthrough`, `aggregate`; `@via` lives here and only here) |
| 4. **Population** | how is this object physically stored/materialized? | `source.*` (`@kind`, `@role`, `@schema`) |
| 5. **Surface** | at what boundary is it exposed, with what operations? | `api` / `operation.*` / `binding.*` (FR-021), `layout.*`, `template.*` |

ADR-0023 discipline runs through everything: **nothing declarable is added where the
fact is computable.**

- Lineage ("this is a view of Customer") is computed from `extends` targets and
  origins — the RFC's proposed `viewOf` structural key is **rejected**.
- Exposure is the declared field set itself (inclusive list, fail-closed by
  construction) — no allowlist mechanism, no exposure flag.
- Read-only-ness is computed (from the projection subtype, or from a field carrying an
  origin) — no `@readOnly` attr.
- The projection's logical key is computed from identity pass-through (§5).
- `@via` is inferable when exactly one single-hop path exists (§6).

## 3. Taxonomy: `object.projection`

A third object subtype joins `entity` and `value`:

- **`object.entity`** — owns its data: own identity, writable sources, lifecycle.
- **`object.value`** — a pure shape: no identity, no source; embedded, passed,
  composed. Constructed, never populated.
- **`object.projection`** — a derived, read-only representation of entities: fields
  extend entity fields and/or carry origins, identity extends through from an entity,
  optionally materialized as a read-only source.

| | field kinds | writable | identity | source |
|---|---|---|---|---|
| **entity** | owned physical (writable) + derived w/ `origin.*` (read-only) | base fields only | own, required | writable + read sources |
| **projection** | `extends`-bound · origin-derived · self-declared (external assembly, e.g. proc-computed) — all read-only *because the subtype is* | never | borrowed via `extends`, optional | read-only `@kind`s only, optional |
| **value** | self-declared, optionally `extends` entity fields for shape (proc params, command inputs) | n/a — constructed | **never** | **never** |

Why a subtype and not a computed pattern: the distinction is a **rule regime, not a
label**. Which children a node may carry (`identity` allowed-and-must-extend on
projection, forbidden on value; `source` read-only-kinds-only on projection, forbidden
on value) is *registry child-licensing* — definitional, not computable — which is
precisely what subtypes exist to declare. Modeling this on `object.value` would force
conditional child rules ("identity on a value is legal only if…"), the
dispatch-on-scattered-conditions smell this design eliminates. `object.value` is
simultaneously **tightened**: no identity, no source, ever (believed free — nothing
shipped does either; verify during implementation).

Two read-only rules, at two levels:

> **A field carrying `origin.*` is *derived*, and derived means read-only — wherever
> it lives.** On an entity it is excluded from INSERT/UPDATE, write codecs, and
> create/update inputs, and marked read-only on the generated model.
>
> **A projection is read-only at the subtype level** — all its fields, including
> self-declared ones, regardless of per-field derivation.

Reconciliation with FR-013: an explicit `@readOnly: true` field attr already ships
(upgrade-only through extends, `ERR_READONLY_DOWNGRADE`/`ERR_READONLY_ASSIGNED_PRIMARY`).
It **remains** — for non-derived fields that are read-only for external reasons (e.g.
DB-computed/trigger-populated table columns). FR-024's two rules are *computed* and
need no attr; the three sources of read-only-ness (subtype-level, origin-derived,
explicit `@readOnly`) compose — each independently makes a field read-only. On
projection fields `@readOnly` is redundant (legal, no effect); the
`field-readonly-on-view-projection` fixture migrates to `object.projection` where its
flags disappear.

## 4. Universal field-`extends`: `extends Entity.field`

The keystone new capability: field-level `extends` may target a **field nested inside
an entity** (`Customer.id`, cross-package `acme::sales::Customer.id`). Today
field-`extends` resolves only top-level abstract fields. Resolution is **type-scoped**:
a field resolves entity fields; an identity resolves entity identities (§5).

This mechanism is **universal**, not projection-specific:

- **Projection fields** — `field.uuid: { name: customerId, extends: Customer.id,
  column: customer_id }`: shape (type/docs/validators) pulls through; the rename is the
  own-`@column`; presence in the projection = presence in the inclusive list.
- **Value fields** — proc parameters and command inputs whose fields are entity ids:
  `field.int: { name: caseId, extends: Case.id }` pulls shape through with **no**
  identity semantics, **no** population, **no** referential (FK) claim.
- **Entity derived fields** — optional shape pull-through alongside the origin (§7).

What every use gets: **load-time drift protection**. Renaming or retyping
`Customer.id` fails `extends` resolution in every projection, proc-args VO, and command
input that references it — the contract breaks the build, not production. This is a
*stronger* gate than verify-time origin resolution: it fires at load.

What it also makes computable: "this parameter is a Case identifier" (the extends
target IS `Case`'s identity field) — doc-gen, FR-022 emission, and future MCP tool
schemas derive the semantic with zero new attrs.

Inheritance semantics are the existing `extends` semantics: child attrs override
(redeclare to pin a validator a versioned surface must not track). One coherence
check: when a field has both `extends X` and `origin.passthrough @from Y`, X and Y must
agree (loader check; exact severity settled at planning).

## 5. Identity pass-through

A projection's identity **extends an entity identity** — the same `Entity.child`
resolution, applied to `identity`. To make identities addressable by the dotted
by-name form, **identity nodes require a `name`** (historically `identity.primary`
was nameless; hard cutover, pre-GA — authors pick the name: `id`, `key`, …):

```yaml
# on Customer:        - identity.primary: { name: id, fields: [id] }
# on the projection:
- identity.primary: { name: id, extends: Customer.id }   # type-scoped → Customer's IDENTITY named id, not the field
```

One declaration, three jobs:

1. **Anchors the primary entity.** The base/FROM relation of the assembled view is the
   extended identity's owner — declared structurally, not inferred. (Inference remains
   a fallback for trivial single-entity projections; ambiguity without an extended
   identity → load error instructing the author to declare one.)
2. **Borrowed identity, stated honestly** — the projection's key *is* the entity's
   key, passed through.
3. **Key-correspondence checks.** For each field in the entity identity's field set,
   the projection must contain a local field whose `extends` target is that entity
   field. Key not projected / projected without `extends` / extending the wrong field
   → load error. The identity cannot claim a pass-through the fields don't make.

The identity's local `fields` list is **computable** from those extends targets —
optional (derived when unambiguous), explicit allowed (must agree).

Identity is **optional** on projections: keyless result sets (stored procs, list-only
views) are legal; without identity there is no get-by-id surface.

## 6. `@via` — assembly paths, on `origin.*` only

`@via` is a dotted **relationship path** (multi-hop is existing grammar:
`"Program.weeks.workouts"`). It lives on `origin.*` and nowhere else — fields never
carry join mechanics.

> **`via` may be omitted only when exactly one single-hop relationship leads from the
> base entity to the `from`/`of` entity. Everything else declares it.**

| Case | `via`? |
|---|---|
| Field on the base entity (no origin at all) | n/a |
| `from` on a related entity, exactly one single-hop relationship to it | omit — inferred |
| A second relationship to that entity is later added | load error at that moment (`ERR_AMBIGUOUS_PATH`-class, naming candidates) — the human decides exactly when ambiguity is introduced |
| Multi-hop | always explicit — a multi-hop join is a design decision (cardinality, row multiplication) |
| Self-join (`from` targets the base entity) | no origin = the base relation itself; the *related* row requires explicit `via` |

Inference stops at single-hop-unique deliberately: the inference algorithm is part of
the **cross-port conformance contract** (five loaders must agree byte-identically);
single-hop-unique is trivially portable, graph search is not.

Cardinality checks give the rules teeth, in the **conservative form** (the 5-port
contract — `@cardinality` is an open string cross-port and may be undeclared;
undeclared hops are never judged, pinned by regression test): a `passthrough`
via-path errors when any hop **explicitly declares** `@cardinality: many`
(row-multiplying passthrough — you meant `aggregate`); an `aggregate` via-path
errors when it is **provably all-to-one** (every hop explicitly declares
`@cardinality: one` — you meant `passthrough`).

## 7. Sources, assembly modes, and the population doctrine

> **`source` answers "where is this populated from?" Values are never populated — they
> are *constructed*** (by a caller: proc args, command inputs; by assembly: prompt
> payloads; by embedding: jsonb/flattened VOs, whose storage belongs to the owning
> entity's field).

| Source kind | Who carries it | Identity? |
|---|---|---|
| `rdb @kind:table` | **entity** only | own, required |
| `rdb @kind:view` / `materializedView` | **projection** (standalone) or **entity** (multi-source, read role) | borrowed / own |
| `rdb @kind:storedProc` / `tableFunction` | result shape = **projection** (today spelled entity — migration candidate, §10); args = **value** via `@parameterRef` (shipped) | optional — result sets are often keyless |
| *(future)* message topic / queue | **nobody** — a topic is a *channel*, not a population location; it belongs to the surface layer as `binding.messaging` on an operation referencing a value (AsyncAPI's model: channels reference message schemas) | n/a |
| no source | **value** (embedded / payload / args) or **projection** (wire-only contract shape) | value: never; projection: optional |

**Assembly modes.** Whether origins are *required* depends on the source:

| Assembly mode | Non-base fields need `origin`? | `extends` still gives |
|---|---|---|
| **Emitted** — the `CREATE VIEW` DDL is generated | yes — the emitter builds the SELECT from origins; `extends`-only on a non-base field = error | shape + load-time drift gate |
| **External** — proc body, table function, hand-written view body | no — the body *is* the assembly; fields may be `extends`-only (declared lineage, opaque assembly) or fully self-declared (proc-computed) | shape + drift gate + semantic lineage for docs/contracts |

Origins remain meaningful when declared on external-assembly sources: verify still
resolves their references; only the DDL emitter consumes them, and it does not run for
external bodies. External bodies are covered by the existing body-drift gates
(view-body drift detection ships in the TS migration toolchain; the proc analogue
follows the same pattern).

**Multi-source entities ("view behavior on the entity").** An entity may declare a
writable table source plus a read-only view source (ADR-0007 roles, inferable from
`@kind`); derived fields (origin-bearing) exist on the read source:

```yaml
- object.entity:
    name: Customer
    children:
      - source.rdb: { table: Customer, role: primary }             # writes
      - source.rdb: { kind: view, table: v_customer, role: replica }  # reads (DDL emitted; ADR-0007 role vocabulary — there is no "read" role)
      - field.uuid:   { name: id }
      - field.string: { name: name }
      - field.string:
          name: countryName
          extends: Country.name                                     # optional shape pull-through
          children: [ origin.passthrough: { from: Country.name } ]  # via omitted: unique single hop
      - relationship.association: { name: country, objectRef: Country, cardinality: one }
      - identity.primary: { name: id, fields: [id] }
```

Writes route to the table (derived fields don't exist there); reads route to the view;
the view DDL is emitted by the **same assembly logic** as projection views — one
emitter, two hosts. Guardrail: a derived field must be *providable* — a read-capable
source must carry it (emitted views include it by construction; external bodies are
trusted + drift-gated); a derived field on a table-only entity → load error. (Emitting
inline ORM joins instead of requiring a view source is a possible future relaxation —
out of scope here.)

## 8. The worked projection

```yaml
- object.projection:
    name: CustomersV1
    package: acme::api
    children:
      - source.rdb: { kind: view, table: customers_v1, schema: api }   # optional materialization
      - field.uuid:   { name: customerId, extends: Customer.id, column: customer_id }
      - field.string: { name: name,       extends: Customer.name }
      - field.string:
          name: countryName
          extends: Country.name
          column: country_name
          children: [ origin.passthrough: { from: Country.name } ]
      - field.int:
          name: orderCount
          children: [ origin.aggregate: { agg: count, of: Order.id, via: Customer.orders } ]
      - identity.primary: { name: id, extends: Customer.id }            # → Customer's identity named id; fields computable → omitted
      # Customer.internalNotes is NOT declared → not in the view, not on the wire. Ever.
```

The RFC's three axes, mapped onto vocabulary that (except the subtype) already exists:

| RFC axis | Where it lives | New vocabulary |
|---|---|---|
| Lineage ("a view of Customer") | computed from `extends` targets + the extended identity | none — no `viewOf` |
| Population ("a DB view in schema api") | `source.rdb { kind, schema, table }` | none (shipped) |
| Exposure ("only these columns") | the declared field set — inclusive list, fail-closed by construction | none — no allowlist flag |

Versioning: `CustomersV2` is a sibling projection; version discipline is
add-fields / new-projection-on-rename-or-remove (governed by exposure, exactly as a
versioned DB view is). A projection serves **multiple surfaces simultaneously** — DB
view (its source), wire contract (referenced by an operation), grid (referenced by a
layout) — answering FR-021's open question 5 (one shape, several consumers) by design.

## 9. The declared API surface (FR-021, aligned)

**`api` subtypes.** The grammar requires a subtype vocabulary; the semantic axis is
the **interaction model** (the axis that changes child-licensing), never the protocol
(protocol lives in `binding.*` on operations — one surface, several protocols):

- `api.base` — abstract.
- `api.operational` — request/response surface; children are `operation.query|command`.
  The one concrete subtype this design ships. Commands carried over queues remain
  `api.operational` (that is a `binding.messaging` on the operation, not a new kind).
- *(reserved)* an event/streaming sibling (true pub/sub: channels/events referencing
  values — different children, hence a different subtype) — future design.

FR-021's vocabulary stands, with contract shapes now properly typed:

```yaml
- api.operational:
    name: CustomerApi
    package: acme::api
    version: v1
    children:
      - operation.query:
          name: listCustomers
          outputRef: CustomersV1
          many: true                                   # list + FR-008 filter/sort/pagination contract
          children: [ binding.rest: { method: GET, path: /v1/customers } ]
      - operation.query:
          name: getCustomer
          outputRef: CustomersV1                       # no inputRef — {id} computable from the
          children:                                    #   projection's borrowed identity
            - binding.rest: { method: GET, path: /v1/customers/{id} }
      - operation.command:
          name: deactivateCustomer
          inputRef: DeactivateCustomerRequest          # object.value; id field extends Customer.id
          outputRef: CustomersV1
          children:
            - binding.rest: { method: POST, path: /v1/customers/{id}:deactivate }
```

Semantics: **queries return projections, commands take values, both act on entities**
(the CQRS reading, exact). Command route shells — parsing, validation (inherited
validators included), typed handler seam — are generated; verb bodies are hand-written
business logic. Derived CRUD (FR-008/009) stays the zero-config default; a declared
`api` extends it (per-entity opt-out of the derived surface, per FR-021). Versioned
surfaces are sibling `api` nodes over sibling projections. Consumers: per-port
controllers (Tier-1), FR-022 contract emitters, `meta docs` api surface, future MCP
exposure (each operation a discoverable tool; input schema = the value's strict-profile
JSON Schema).

**Scope: core.** `object.projection`, `Entity.child` extends-resolution,
`api.operational` / `operation.query|command` / `binding.rest` enter the core
registered providers —
`expected-registry.json` updated atomically across all five ports, conformance
fixtures for every loader rule in this design. `binding.*` is the extension seam
(`messaging`/`grpc` later, as registered subtypes — never freeform attrs).

**Boundary: the organization tier stays out.** Application / service / network /
deployment / integration modeling is layered by an organization-level metadata tier
via the provider SPI, referencing these core nodes by FQN. Core owes that tier exactly
one thing — `api` and `projection` nodes are named, packaged, resolvable — true by
construction. (Prior art reviewed for this design modeled that tier with CSV string
references — `exposedObjects: "a,b,c"` — unresolvable, fail-open, verify-blind; the
FQN-resolvability contract is the lesson.)

## 10. Codegen, migration, and gaps to build

**Generated shape per representation:**

| Representation | Modeled by | Generated |
|---|---|---|
| Entity table | `object.entity` + table source | entity class, full CRUD (unchanged) |
| Entity w/ view behavior | entity + read view source + derived fields | writes→table, reads→view; derived fields read-only on the model, excluded from write codecs + create/update inputs; view DDL emitted |
| Versioned API view | `object.projection` + view source | read-only model + `ProjectionOf<Customer>` marker (computed lineage) + read-only data access + view DDL |
| Wire-only contract | `object.projection`, no source | read-only DTO + marker; no DDL |
| REST surface | `api`/`operation`/`binding.rest` | per-port controllers/routes; FR-022 artifacts |
| UI grid | `layout.dataGrid` over entity or projection | grid config (existing; gains projection hosting) |

**Gaps to build** (each conformance-gated, all five ports unless Tier-2):

1. `Entity.child` extends-resolution (fields + identities), type-scoped, cross-package
   — the keystone; all five loaders.
2. `object.projection` registration + child-licensing + the loader checks in §§3–7
   (value purity; read-only source kinds; identity pass-through + key correspondence;
   extends/origin agreement; via inference/ambiguity/cardinality; derived-field
   providability).
3. View-DDL emitter: identifier quoting + schema qualification (existing bug — reuse
   the table emitter's helpers); assembly from extends-bindings + origins; one emitter
   serving projections and entity read-views (Tier-2, golden-DDL fixtures).
4. Read-only codegen per port: projection models/markers/data access; derived-field
   exclusions on entities.
5. `api`/`operation`/`binding.rest` loading + route-shell codegen per port (FR-021
   implementation, on this design's shapes).
6. Registry-conformance manifest updates, atomically, all five ports.

**Removals — hard cutover, no deprecation path** (pre-GA, no users). One loader rule
kills both pre-taxonomy spellings: **an entity's primary source must be a writable
`@kind` (`table`); read-only kinds are legal only in read role.** Consequently:

- `object.entity` + `extends <Entity>` + view source (the firehose pattern, e.g.
  `ProgramSummary`) → load error; rewritten as `object.projection` (own fixtures and
  corpus entries migrated in Phases B/E).
- Stored-proc result shapes as `object.entity` (e.g. the `parameter-ref-on-stored-proc`
  fixture) → load error; rewritten as `object.projection` (identity becomes
  optional-borrowed).
- `object.value` + `origin.*` prompt payloads (FR-004): **untouched** — values still
  carry origins for assembly semantics; no migration forced.

**Deferred / follow-ups:** `origin.expression` (computed SQL columns: CAST/COALESCE/
CASE) — additive origin subtype, separate design; inline-ORM-join population for
entity derived fields without a view source; `binding.messaging`/`binding.grpc`;
FR-022 consumes this design's shapes (wireId placement on projections/values per
FR-021 §3 stands).

## 11. Open items (settle at planning)

1. Exact error codes for the new loader checks (reuse `ERR_BAD_ATTR_VALUE` /
   `ERR_INVALID_RELATIONSHIP` families vs new codes; conformance fixtures fix them).
2. `operation` attr set (`many`, pagination style per binding — FR-021 open Qs 1–2)
   and path-template ↔ identity validation for `binding.rest`.
3. Severity of the extends/origin target-agreement check (warn vs error).
4. Whether `identity.primary { extends }` requires the projection to be
   single-base-entity (composite multi-entity keys deferred?).
