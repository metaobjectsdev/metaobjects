# ADR-0030: The declared API surface lives in core; protocol lives in bindings; the organization tier stays out

## Status

Accepted (2026-06-12). Defined by FR-024 §9
(`docs/superpowers/specs/2026-06-12-fr-024-entity-surfaces-projections-design.md`);
aligns and grounds the FR-021 design sketch.

## Context

Derived CRUD (FR-008/009) is convention-computed; non-CRUD operations and versioned
wire contracts had no declared home. Prior art reviewed for this design modeled
APIs/endpoints at an organization tier with CSV string references
(`exposedObjects: "a,b,c"`) — unresolvable, fail-open, invisible to verify. The
protocol-as-subtype trap (`api.rest` / `api.graphql` / `api.grpc`) was also
observed there.

## Decision

1. **Core vocabulary:** `api.base` / **`api.operational`**, `operation.query` /
   `operation.command`, and `binding.rest` enter the core registered metamodel
   providers, gated by registry-conformance in all five ports.
2. **The `api` subtype axis is the interaction model** — the axis that changes
   child-licensing — **never the protocol.** `api.operational` is the
   request/response surface whose children are operations; an event/streaming
   sibling (channels/messages — different children) is reserved for a future
   design. Protocol lives in `binding.*` ON operations (`rest` now; `messaging`,
   `grpc` later as registered subtypes), so one surface serves several protocols.
   A command carried over a queue is still `api.operational` — that is a binding,
   not a kind.
3. **Shapes are referenced, never defined, by the surface:** queries return
   `object.projection`s, commands take `object.value`s, both act on entities.
   A get-by-id operation needs no `inputRef` — its parameter is the projection's
   borrowed identity, computed.
4. **Derived CRUD remains the zero-config default**; a declared `api` extends it
   (per-entity opt-out per FR-021). Versioned surfaces are sibling `api` nodes
   over sibling projections.
5. **The organization tier (application / service / network / deployment /
   integration) stays OUT of core**, layered by an organization-level metadata
   tier via the provider SPI. Core owes that tier exactly one thing: `api` and
   `projection` nodes are named, packaged, FQN-resolvable — so upper-tier
   references are verifiable, never string CSVs.

## Consequences

- FR-022 emitters and future MCP exposure consume declared operations; route
  shells (parsing, validation, typed handler seam) are generated, verb bodies are
  hand-written business logic.
- The FR-021 sketch's contract shapes are retyped onto
  `object.projection`/`object.value` (FR-024 §9); its `wireId` placement stands.
- `binding.*` additions are registered subtypes, never freeform attrs (ADR-0023,
  sealed registry).
