# Contract emitters: `contract-schema` and `openapi`

_`jsonSchemaFile()` and `openApiFile()`: write the model's wire contract as plain JSON Schema 2020-12
and OpenAPI 3.1, so a consumer in any language can work from a standard document instead of a fourth
hand-kept source of truth._

**Status:** TypeScript reference helpers, unreleased, targeting 1.2.1 (FR-022;
[ADR-0034](../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md) Amendment 10). They are listed
by `meta gen --list`, imported from `@metaobjectsdev/codegen-ts/generators` to run as shipped, copied
with `meta eject contract-schema openapi` to change them, and checked by `meta verify --codegen`. They
are not core: what MetaObjects guarantees is the model, and a generator that writes files into your
repo is a helper you can copy and own. They add no vocabulary and no runtime: the files import nothing.

**What they do.** `contract-schema` writes a JSON Schema for each object's read, create and update
shapes, and on request a strict subset for structured output. `openapi` writes one document for the
generated REST surface, with those shapes as its components. Both state what the routes in every
port actually send and take, under the project's [`wire` setting](api-contract.md#the-wire-setting).

**What they do not do.** They generate no client and no server, and they do not validate anything at
runtime. Run openapi-generator, Kiota or orval on the document for a client. The protobuf emitter in
the [design](../superpowers/specs/2026-06-11-fr-022-contract-emitters-design.md) is not built; it is
planned with binary protocols for 1.3.

**Entirely opt-in.** `meta init` wires no generator. A project that does not list them gets no file.

## Wiring

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { jsonSchemaFile, openApiFile } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  apiPrefix: "/api",
  generators: [
    jsonSchemaFile(),
    jsonSchemaFile({ profile: "strict", filter: (obj) => obj.name === "SupportTicket" }),
    openApiFile({ title: "Shop API", version: "2.1.0" }),
  ],
});
```

List `jsonSchemaFile()` twice to get both profiles. Commit what they write, like any generated file:
`meta verify --codegen` re-runs them and fails when a file is stale, so the contract cannot drift from
the model.

### Options

| Generator | Option | Default | |
|---|---|---|---|
| both | `filter` | every object | Narrow what is covered. An object a kept one references stays, so a `$ref` never dangles. |
| both | `target` | the default target | The named output target the files land under. |
| `jsonSchemaFile` | `profile` | `"canonical"` | `"strict"` writes the structured-output subset. |
| `openApiFile` | `title`, `version`, `description` | `API`, `0.0.0`, none | The document's `info`. |
| `openApiFile` | `servers`, `securitySchemes`, `security` | none | Passed through untouched. See [Security](#security-and-servers). |
| `openApiFile` | `expose` | what the routes generators declare, else every verb | The verbs your routes mount. Needed when another port generates them. |

## What it writes

```
<outDir>/
├── openapi.json
└── schemas/acme/commerce/
    ├── Order.schema.json           # what a read answers
    ├── Order.create.schema.json    # what a create takes
    ├── Order.update.schema.json    # what an update takes
    ├── Order.strict.schema.json    # with profile: "strict"
    └── Address.schema.json         # a value object: read and create shapes only
```

Schemas reference one another by relative `$ref`, so any validator loads the directory as it is. In
the document, the same shapes are `Order`, `OrderCreate` and `OrderUpdate` under `components.schemas`,
alongside `OrderList`, `OrderPage` and `ApiError`.

A projection and a report are read-only, so they have a read shape only.

### Why three shapes

A read, a create and an update differ in what is required and what may be null, and one schema with
`readOnly` and `writeOnly` could state neither correctly.

| Shape | Required | Optional fields | Left out |
|---|---|---|---|
| read | every key | present, and `null` when empty | a credential (`view.password`) |
| create | `@required` fields | may be left out, may not be `null` | server-set fields, a generated key, `@formExclude`, credentials, a pinned TPH discriminator |
| update | none | may be left out, and `null` clears them | server-set fields, `@formExclude`, credentials, a TPH discriminator |

A nested value object in a write takes the target's create shape. A column several TPH subtypes
declare is one column, so a credential or `@formExclude` on one declaration holds on every subtype
that has it, as it does in the routes.

## Types

Each field is what [the REST contract](api-contract.md#type-encodings-tier-1-invariant) says it sends.

| Field | JSON Schema |
|---|---|
| `field.int` | `integer`, `format: int32` |
| `field.long` | `integer`, `format: int64`. A JSON number, not a string |
| `field.currency` | `integer`, `format: int64`, with the ISO code in `description` |
| `field.double`, `field.float` | `number`, `format: double` / `float` |
| `field.boolean` | `boolean` |
| `field.date` | `string`, `format: date` |
| `field.time` | `string`, a `pattern`. RFC 3339 `time` demands an offset, which this type has not got |
| `field.timestamp` | A read is `format: date-time`. A write or a filter also takes a value with no offset, read as UTC, so it is a `pattern`. With `@localTime`, a `pattern` with no offset everywhere |
| `field.uuid` | `string`, `format: uuid` |
| `field.uri`, `field.inet` | `format: uri`, or either of `ipv4` and `ipv6`. With `@lenient`, a plain `string` |
| `field.enum` | `string`, `enum` |
| `field.string` | `string`. `@stringFormat` adds `format: email` / `hostname`, and a `@dbColumnType: jsonb` bag is `{}` |
| `field.object` | a `$ref` to the target |
| `field.decimal` | see below |

Length and range validators become `minLength`, `maxLength`, `minimum`, `maximum` and `pattern`.

### Set the wire form if you publish a contract

Two things on the wire depend on the server's language unless the project fixes them, and the schemas
say exactly that.

| Setting | Value | A read in the schema |
|---|---|---|
| `wire.decimals` | `"string"` | a string holding the canonical pattern |
| `wire.decimals` | default | `["string", "number"]`, since each language writes its own form |
| `wire.nullMembers` | `"omit"` | a value object's optional member is absent, and not nullable |
| `wire.nullMembers` | `"emit"` | the member is always present, and nullable |
| `wire.nullMembers` | default | absent or `null` |

A project that publishes this contract should fix both in `.metaobjects/config.json`, because a client
generated from `["string", "number"]` has to handle two types:

```json
{ "wire": { "decimals": "string", "nullMembers": "omit" } }
```

A write takes a decimal as a string or a number in every setting. A top-level optional field is
always written, as `null`, in every setting.

## The strict profile

`profile: "strict"` writes one self-contained `<Name>.strict.schema.json` per object, for a model to
fill in: OpenAI strict mode, Anthropic structured outputs, an MCP `inputSchema`. It is the intersection
of what those hosts accept.

- It covers the create shape, or the read shape where there is none.
- Every property is `required`, and an optional one is `["T", "null"]`.
- Every object has `additionalProperties: false`, and every `$ref` is inlined.
- It holds no `$schema` or `$id`. `format`, `pattern` and bounds move into `description` as prose.

What the subset cannot state is refused, not dropped, because a schema narrowed in silence gives a
model a different contract from the one you declared. A map, an open object, a recursive type or a
reference to a polymorphic TPH base reached through a read shape, that is, from an object with no
create shape, stops the run with `ERR_CONTRACT_STRICT_UNREPRESENTABLE`, naming the path. Leave that
object out with `filter`. A reference from a create shape inlines the base's own create fields. A TPH
base gets no strict file of its own, because each of its subtypes has one.

## The OpenAPI document

It covers what the generated routes serve: the CRUD paths, the bracketed filter grammar with each
field's allowed operators, `sort`, `limit`, `offset` and `withCount`, M:N traversal, TPH polymorphic
and per-subtype mounts, projections, reports (with the `format` parameter when `report-export` is
wired), and the error envelope.

A list answers an array, or `{ rows, total }` with `withCount=1`, so its response is a `oneOf` of
`<Name>List` and `<Name>Page`.

The document covers the whole model, narrowed by `filter` and the project's `scope`. It never depends
on the run: `meta gen Author` writes the same bytes as a full `meta gen`.

### Security and servers

Authentication and deployment are facts about your application, and the model is shared across both,
so they are options:

```ts
openApiFile({
  title: "Shop API",
  version: "2.1.0",
  servers: [{ url: "https://api.example.com" }],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
});
```

### Left out on purpose

- The `default` keyword: a default belongs to the database or to `@autoSet`, and is not on the wire.
- `readOnly` and `writeOnly`: the shapes are separate.
- The TypeScript-only `search`, `filter[or]` and `filter[and]` extensions: the document states the
  cross-port contract ([api-contract.md](api-contract.md)).
- 405 answers: a verb a read-only surface does not serve is absent from the document.
- Routes you wrote by hand. Eject `openapi` and add them in `buildOpenApiDocument` if you want them
  documented.

## Other ports

The output depends on the model and the `wire` setting, and never on the server's language, so there
is one engine and every project runs it through the Node `meta` CLI. All five ports answer the same
REST contract, so the document is right for all of them.

A Java, Kotlin, Python or C# project lists the generators in a `metaobjects.config.ts` beside its
model and passes `expose`, because that run cannot see the routes another port generates:

```ts
openApiFile({ title: "Shop API", version: "2.1.0", expose: ["list", "get", "create", "update"] });
```

## Check a change against the last release

Compare the document at your last tag with the one at `HEAD`. A new optional field passes, and a
removed field or filter fails: [Check an API change against the last release](../recipes/check-api-against-last-release.md).

## How it is checked

- **The corpus.** [`fixtures/contract-conformance/`](../../fixtures/contract-conformance/) holds golden
  trees for each model shape and wire setting, and the refusals.
- **Stock validators.** Each schema compiles in strict Ajv, each strict file holds to the subset, and
  each document passes the OpenAPI 3.1 specification's own schema.
- **Real traffic.** Each exchange in the TypeScript generated API lanes is held to the golden
  document: the route and status must be documented, a 2xx request must be one it accepts, and the
  response must match. A server and a document that drift apart fail there.
- **oasdiff.** A test runs real oasdiff over two emitted documents.

## Errors

| Code | Meaning | Fix |
|---|---|---|
| `ERR_CONTRACT_NAME_COLLISION` | Two things would take one component name, such as an object `OrderCreate` beside the create shape of `Order`, or one `operationId`, such as the `tags` traversal of `Post` beside an object `PostTags` | Rename one, or leave one out with `filter` |
| `ERR_CONTRACT_STRICT_UNREPRESENTABLE` | The strict subset cannot state an object | Leave it out of the strict entry with `filter` |
