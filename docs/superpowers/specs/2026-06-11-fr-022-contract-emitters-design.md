# FR-022 — Contract emitters: JSON Schema → OpenAPI 3.1 → protobuf (design)

_Status: PROPOSED (design sketch — needs brainstorming + plan before implementation)._
_Date: 2026-06-11._

## Problem

Adopters keep their existing contract ecosystems: validation tooling wants JSON Schema,
REST consumers want OpenAPI, gRPC shops want `.proto`. Today MetaObjects generates the
*implementation* (routes, models) but not the *neutral contract artifacts*, so adopters
hand-write them — a drift surface the metadata fully describes (raison-d'être violation).

## Design direction

All three emitters are **Tier-2** per ADR-0020 (output bytes don't depend on the
implementing language → ONE shared TS engine + golden-file conformance fixtures), wired
as ordinary generators (stable names in the generator registry, `gen --list`). They are
**one layered investment**, built in this order:

### Phase 1 — JSON Schema 2020-12, two profiles

- `jsonSchemaFile()` — per-entity / per-projection `<Name>.schema.json`:
  - **Canonical profile**: full fidelity. `$defs` for shared abstracts, `format:
    uuid/date-time/...`, `field.enum @values` → `enum`, currency → integer minor units
    (description carries the ISO code), wire-contract-faithful types (decimal as string,
    int64 as string — must match `normalization.md` exactly or the emitter itself becomes
    a drift source; conformance-gated).
  - **Strict profile** (`profile: "strict"`): the cross-provider structured-output
    intersection — root `type: object`; every property `required` with `["T","null"]`
    unions for optionals; `additionalProperties: false` everywhere; **no recursion**; no
    numeric/length constraint keywords (`@maxChars` etc. become `description` prose).
    This one artifact serves OpenAI strict mode, Anthropic structured outputs, and MCP
    hosts with restricted schema subsets.
- Consumers unlocked: validators in every language, MCP `inputSchema`, LLM
  structured-output schemas, OpenAPI components (Phase 2), schema-registry JSON mode,
  quicktype-class codegen for languages without a MetaObjects port.

### Phase 2 — OpenAPI 3.1

- `openapiFile()` — one document describing the generated REST surface
  (accurate-by-construction: derived-CRUD routes + FR-021 declared operations), with
  `components.schemas` = Phase 1 canonical output (OpenAPI 3.1 schemas ARE JSON Schema
  2020-12). Covers: CRUD paths, the bracketed filter grammar + operator-per-subtype
  gating, sort/limit/offset (+`withCount`), M:N traversal routes, error envelopes.
- `meta verify` gains a spec↔routes drift check (regen-to-temp diff, like `--codegen`).
- Emit 3.1 canonical; optional 3.0-downlevel flag (consumer tooling lag is real —
  evaluate per demand).
- Multiplier: openapi-generator / Kiota / orval turn the document into client SDKs in
  languages MetaObjects doesn't port.

### Phase 3 — protobuf (proto3)

- `protoFile()` — `.proto` per package + AIP-style CRUD services (Get/List/Create/
  Update/Delete + FR-021 custom operations) with `google.api.http` annotations (REST
  transcoding / gRPC-Gateway / Connect-compatible).
- **Field numbers come from FR-021 `wireId`** (required on proto-bound projections;
  emit-time error if missing). `reservedWireIds/Names` → `reserved` statements.
- Type mapping (locked by research; conformance-gated):
  long→`int64` (ProtoJSON already strings 64-bit — matches our wire contract) ·
  decimal→`google.type.Decimal` (string-valued) · currency→`int64` minor units (NOT
  `google.type.Money` — Money is units+nanos, a different contract; offer Money only as
  an opt-in with explicit conversion) · uuid→`string` (never `bytes`: endianness
  hazards) · timestamp→`google.protobuf.Timestamp` (UTC) · date/time→`google.type.Date`
  / `TimeOfDay` · nullable→proto3 `optional` (never wrapper types) · enum→synthesized
  `<ENUM>_UNSPECIFIED = 0` zero value + prefixed member names + member `wireId`s ·
  `field.object @storage: jsonb`→`google.protobuf.Struct`, flattened/subdocument→nested
  message · arrays→`repeated`.
- **CI gate**: document (and scaffold in `meta init` recipes) `buf breaking
  --against` on the emitted, committed protos (WIRE_JSON category) — wire-compat
  regression detection is inherited from buf rather than re-implemented.
- Explicit non-goals: no runtime descriptor construction in this FR (per-language
  descriptor APIs are uneven — notably no dynamic message support in one major port
  ecosystem) and no gRPC *server* codegen — adopters run protoc/buf on the emitted
  contract with their existing toolchains.

## Conformance

New `fixtures/contract-conformance/` (or per-emitter fixture trees): golden emitted
artifacts byte-gated from shared input metadata; strict-profile outputs validated
against provider schema-subset rules; proto outputs additionally `buf lint`/`buf
breaking`-clean in CI.

## Open questions

1. Package/file layout for emitted artifacts (per-entity vs per-package files; where in
   `targets` they land).
2. OpenAPI security schemes: out of metadata scope (config passthrough?) or modeled?
3. Whether Phase-1 strict profile needs per-provider sub-variants or one intersection
   profile suffices (start: one).
4. proto package naming + `option java_package` etc. mapping from `::` packages.

## Dependencies

- FR-021 (declared operations + `wireId`) for Phase 3 and for non-CRUD coverage in
  Phase 2; Phases 1–2 are useful with derived CRUD alone and can ship first.
