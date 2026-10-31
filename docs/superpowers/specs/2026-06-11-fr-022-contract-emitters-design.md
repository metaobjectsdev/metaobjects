# FR-022 — Contract emitters: JSON Schema → OpenAPI 3.1 → protobuf (design)

_Status: ACCEPTED. Phases 1 and 2 (JSON Schema, OpenAPI) are implemented for 1.2.1. Phase 3 (protobuf)
is not started and stays with binary protocols under 1.3._
_Date: 2026-06-11. Settled and revised 2026-10-30._

The sketch below keeps its direction. Where building it showed a claim to be wrong, the text is
corrected and "Decisions settled" says why. The user-facing page is
[`docs/features/contract-emitters.md`](../../features/contract-emitters.md).

## Problem

Adopters keep their existing contract ecosystems: validation tooling wants JSON Schema,
REST consumers want OpenAPI, gRPC shops want `.proto`. Today MetaObjects generates the
*implementation* (routes, models) but not the *neutral contract artifacts*, so adopters
hand-write them — a drift surface the metadata fully describes (raison-d'être violation).

## Design direction

All three emitters are **Tier-2** per ADR-0020, superseded by ADR-0022 (output bytes don't
depend on the implementing language → ONE shared TS engine + golden-file conformance
fixtures), wired as ordinary generators (stable names in the generator registry, `gen
--list`). They are **one layered investment**, built in this order:

### Phase 1 — JSON Schema 2020-12, two profiles

- `jsonSchemaFile()` (stable name `contract-schema`) — per-object `<Name>.schema.json`, with
  `<Name>.create.schema.json` and `<Name>.update.schema.json` for the write shapes:
  - **Canonical profile**: full fidelity. A file per object, referenced by a relative `$ref`, in
    place of the sketch's `$defs`; `format: uuid/date-time/...`, `field.enum @values` → `enum`,
    currency → integer minor units (description carries the ISO code), wire-contract-faithful
    types: what `docs/features/api-contract.md` says each field sends, under the project's
    `wire` setting. It must match exactly or the emitter itself becomes a drift source;
    conformance-gated.
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

- `openApiFile()` — one document describing the generated REST surface
  (accurate-by-construction: derived-CRUD routes), with
  `components.schemas` = Phase 1 canonical output (OpenAPI 3.1 schemas ARE JSON Schema
  2020-12). Covers: CRUD paths, the bracketed filter grammar + operator-per-subtype
  gating, sort/limit/offset (+`withCount`), M:N traversal routes, error envelopes.
- Drift is `meta verify --codegen`, which already re-runs every declared generator. No new
  flag and no new check.
- Emit 3.1 only. A 3.0 downlevel is not built; it waits for an adopter who needs one.
- A change to the API is checked against the last release by oasdiff over two emitted
  documents. It is a recipe, with no verify flag: the tool already exists and does this well.
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

## Decisions settled

The sketch's open questions, and what building it decided. Each one is settled from the repo's
own rules. None needed a product decision from outside them.

1. **Layout (open question 1).** One file per object under
   `schemas/<package path>/`, because a validator and a schema registry both address a schema
   by file, and a per-package file would change for every object in it. One `openapi.json`, the
   shape every OpenAPI tool expects. Both land under the default target and take a `target`
   option like any generator. Two objects that would take one component name are refused with
   `ERR_CONTRACT_NAME_COLLISION`, never suffixed: a suffix would change a public name when an
   unrelated object was added.
2. **Security schemes (open question 2): options, not metadata.** Authentication sits at the
   application's seam, and ADR-0030 keeps the deployment tier out of the model. An attribute for
   it would have to pass ADR-0023's "cannot be computed" test for a fact the model should not
   hold at all. `securitySchemes`, `security`, `servers`, `title`, `version` and `description`
   pass through `openApiFile()` untouched.
3. **Strict profile (open question 3): one intersection profile, no per-provider variants.** A
   strict file covers the object's create shape, the thing a model is asked to fill in, or its
   read shape when it has no create shape. It carries no `$schema` or `$id`, because some hosts
   refuse them, and `format`, `pattern` and the bound keywords become `description` prose. What the
   subset cannot state (a map, an open object, a recursive type, a polymorphic base) is
   **refused with `ERR_CONTRACT_STRICT_UNREPRESENTABLE`, naming the path**, never dropped: a
   silently narrowed schema gives a model a different contract from the one declared. A project
   leaves such an object out with `filter`.
4. **Proto naming (open question 4).** Left to Phase 3 with the rest of it.
5. **Stable names.** `json-schema` was already taken: it is the Java generator for metadata
   files, a different concept. The emitter's stable name is `contract-schema`, its factory
   `jsonSchemaFile()`. The OpenAPI generator is `openapi`, factory `openApiFile()`, the spelling
   the recipe already used.
6. **A 64-bit integer is a JSON number, not a string.** The sketch said int64 as string, citing
   `normalization.md`. That document is the persistence comparator; the REST contract
   (`docs/features/api-contract.md`, "Type encodings") sends `field.long` as a number. So
   `field.long` is `integer` with `format: int64`, and the Phase 3 note that ProtoJSON strings
   64-bit integers now states a difference from the REST wire, not a match.
7. **Decimals follow the wire setting (ADR-0019 Amendment 2).** Under `wire.decimals: "string"` a
   read is a string holding the canonical pattern. Under the default it is `["string", "number"]`,
   because the form belongs to the server's language and this engine is neutral: it reads the
   setting and never the port. A write takes either in every mode, as the contract says. The docs
   tell a project that publishes a contract to set the string form.
8. **Null members follow the wire setting too.** A top-level optional field is always present,
   null when empty. A value object's optional member follows `wire.nullMembers`: `omit` is absent
   and non-null, `emit` is present and nullable, and the default takes either.
9. **Three shapes per writable object.** A read, a create and an update differ in what is
   required and what may be null, so one schema with `readOnly`/`writeOnly` would state neither
   correctly. A create's optional field may be left out and may not be null (the generated
   `InsertSchema` refuses null). An update's may be null, which clears it (FR-035). A value object
   has a read and a create shape: a nested write uses the target's create shape.
10. **Times use patterns.** RFC 3339 `time` and `date-time` demand an offset, which `field.time`
    and an `@localTime` timestamp do not have. A `format` would reject every real value. An instant
    is `date-time` on a read, which is what routes answer, and a pattern on a write and in a filter,
    because routes also take a value with no offset and read it as UTC. Holding real traffic to
    the document found this: the api-contract corpus sends one, and `date-time` refused it.
11. **Generated by every project through Node.** `ports: ["typescript"]`, `tier: "neutral"`, like
    `docs`. A project on another port runs the Node `meta` CLI over its model and passes `expose`
    to `openApiFile()` for the verbs it mounts, since this run cannot see those routes. All five
    ports answer the same REST contract, so the document is right for all of them.
12. **Stock generators, by decision (ADR-0034 Amendment 10).** Amendment 4 made these two recipes
    and "not a product surface". The captain reversed that for these two. They are still reference
    helpers: ejectable, and not core.
13. **List responses have named components.** `<Name>List` and `<Name>Page`, in a `oneOf`. Found by
    running oasdiff: inline, every new field on a row read as a replaced `oneOf` and a compatible
    change was reported as a breaking one.
14. **The recipe uses `--fail-on WARN`.** oasdiff grades a removed query parameter a warning,
    because most APIs ignore a parameter they do not know. These routes answer it with a 400, so
    here it is a break.
15. **Left out on purpose.** The `default` keyword (a database or `@autoSet` fact, not a wire one),
    the TypeScript-only `search`, `filter[or]` and `filter[and]` extensions, and the 405 answers on read-only
    surfaces (a route that does not exist is absent from the document).

## Implementation

- Engine: `server/typescript/packages/codegen-ts/src/contract/`.
- Generators: `generators/contract-schema-file.ts` and `generators/openapi-file.ts`, each with a
  reference copy under `reference/`.
- Corpus: `fixtures/contract-conformance/`. Golden trees, every document put through Ajv and the
  OpenAPI 3.1 schema, refusals as `expected-error.txt`.
- Integration: every exchange in the TypeScript generated API lanes is held to the golden document
  by `integration-tests/src/api-contract-openapi-check.ts`. `integration-tests/test/contract-oasdiff.test.ts`
  runs real oasdiff over two documents.

## Dependencies

- Phases 1 and 2 stand on derived CRUD alone. FR-021 was closed as not planned, so the document
  covers the routes the generators derive and no declared operations.
- FR-021's `wireId` was to number Phase 3's fields. That phase has to settle where they come from
  before it starts.
