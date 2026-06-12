# FR-021 — `api` metadata type + contract projections (design)

_Status: PROPOSED — REVISED by FR-024 (2026-06-12): contract shapes retyped onto `object.projection`/`object.value`; `api.base`/`api.operational` subtype vocabulary per ADR-0030; `wireId` + emitter direction stands. See `2026-06-12-fr-024-entity-surfaces-projections-design.md`._
_Date: 2026-06-11._

## Problem

The generated REST surface is **convention-derived**: FR-008/FR-009 define a cross-port
CRUD contract (routes, filter grammar, pagination) computed from each entity. That covers
CRUD well, but three needs have no declared home:

1. **Non-CRUD operations** (RPC-shaped actions, batch ops, domain verbs) — today they are
   hand-written outside the metadata, invisible to `verify` and to doc/contract emitters.
2. **Versioned wire contracts** — an API surface that must stay stable while the domain
   entities evolve (v1 and v2 served simultaneously over the same entities).
3. **Contract emission** (FR-022: JSON Schema / OpenAPI / protobuf) — emitters need a
   declared operation surface and, for protobuf, **wire-stable field numbering**, which
   must not live on domain entities (it would couple domain evolution to wire compat).

## Design direction

### 1. API payloads are projections (reuse, don't invent)

An operation's input/output references an `object.value` VO whose fields carry the
existing `origin.*` provenance (`passthrough` / `aggregate` / `collection`) from entities
— the **same projection machinery** that already drives prompt payloads (FR-004) and DB
views (FR-003). The entity stays domain truth; the API projection is the contract surface.
Renaming an entity field re-points (or breaks) the projection's `origin.*`, which `meta
verify` catches at build time — the wire shape never silently changes.

### 2. New metamodel vocabulary (provider-registered, ADR-0023)

Slim sketch (names to be settled in brainstorming):

```yaml
api:                       # new top-level type; protocol-neutral surface
  name: ProgramApi
  version: v1              # bare attr; versioned surfaces = sibling api nodes
  children:
    - operation:           # subtypes: query | command (read vs write semantics)
        name: getProgram
        inputRef: ProgramIdParam     # object.value projection (or none)
        outputRef: ProgramSummary    # object.value projection
        children:
          - binding.rest: { method: GET, path: "/programs/{id}" }
          # future: binding.grpc, binding.messaging — per-protocol bindings
```

- **Derived CRUD stays the zero-config default.** With no `api` declared, FR-008/009
  behavior is unchanged. A declared `api` *extends* (or, per entity opt-in, replaces)
  the derived surface. Emitters consume the union.
- `binding.*` keeps the surface protocol-neutral with per-protocol attrs where they
  belong (REST method/path now; gRPC service/method naming later).

### 3. Wire-stable numbering lives on the contract projection

protobuf field numbers identify fields **on the wire**; renumbering silently misdecodes
(it is equivalent to delete+add). Numbers therefore must be **authored, append-only
metadata** — they genuinely cannot be computed from the model across schema evolution,
which is the ADR-0023 "cannot be computed" justification recorded here.

- `wireId: <n>` on fields of an `object.value` used as a contract projection (and
  `wireId` on `field.enum` members where the enum crosses the wire). Protocol-neutral
  name on purpose: protobuf consumes it now; Avro/Thrift-style emitters could later.
- `reservedWireIds: [..]` + `reservedWireNames: [..]` on the VO — emitted as proto
  `reserved` so deleted fields can never be reused.
- Validation (loader, own-only): duplicate `wireId` in one VO → `ERR_BAD_ATTR_VALUE`;
  `wireId` outside 1..536870911 or in 19000..19999 → `ERR_BAD_ATTR_VALUE`; a VO
  referenced by a proto-bound operation with any field missing `wireId` → emit-time
  error in FR-022 (not a load error — VOs without proto bindings don't need numbers).
- Precedent: TypeSpec's protobuf emitter requires `@field(n)`; entproto requires
  `entproto.Field(n)`. Auto-numbering from declaration order is explicitly rejected
  (insert/rename/delete renumbers the tail = wire break).

### 4. Relationship to the enterprise tier

Application/ecosystem/dependency-level modeling (which org unit owns which API, what
consumes what) is intentionally **out of scope** for this library — `api` here is the
slim contract vocabulary only. An organization-level metadata tier can layer on top via
the provider SPI without changes here.

## Conformance + verify

- New `fixtures/conformance/` fixtures: api/operation/binding loading, wireId validation
  errors, projection-ref resolution errors (`format: "resolved"` envelopes).
- `meta verify --templates`-style gate extended: operation input/output refs must
  resolve; projections' `origin.*` must resolve against entities (existing machinery).
- Registry-conformance manifest gains the new vocabulary in all 5 ports (atomic, like
  the `@responseRef` carve-out close).

## Open questions (settle in brainstorming)

1. Operation vocabulary: AIP-style five standard methods + custom, or free-form
   query/command only?
2. Pagination style per surface: the FR-008 `limit/offset` contract vs AIP
   `page_size/page_token` when emitting proto services — per-binding attr?
3. Does `endpoint` (a node per HTTP route) deserve first-class existence, or is
   `operation` + `binding.rest` sufficient? (Lean: the latter — fewer types.)
4. Versioning semantics: sibling `api` nodes (v1, v2) vs `@version` on operations.
5. Can a contract projection ALSO be a DB view projection (one VO, two consumers), or
   should that be discouraged by validation?

## Dependencies / consumers

- Consumes: `object.value` + `origin.*` (shipped), provider SPI (shipped).
- Consumed by: FR-022 contract emitters; generated API docs (`meta docs` api surface);
  future MCP exposure (declared operations become discoverable tools).
